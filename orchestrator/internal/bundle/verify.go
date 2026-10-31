// Package bundle verifies a control-plane package before service installation.
// Hashes establish integrity against the supplied manifest, not publisher trust.
package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type File struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type Manifest struct {
	Schema       int    `json:"schema_version"`
	Component    string `json:"component"`
	Version      string `json:"version"`
	Commit       string `json:"commit"`
	Dirty        *bool  `json:"source_dirty"`
	Platform     string `json:"platform"`
	Architecture string `json:"architecture"`
	Files        []File `json:"files"`
}

func digest(value string, length int) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == length && strings.ToLower(value) == value
}

func validPath(name string) bool {
	if !fs.ValidPath(name) || name == "." || strings.ContainsAny(name, "\\:\x00") || path.Clean(name) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.TrimRight(part, " .") != part {
			return false
		}
	}
	return true
}

// Verify checks a complete, immutable package tree without executing its files.
// The package must be stored separately from configuration and runtime data.
func Verify(directory, platform, architecture string) (*Manifest, error) {
	return verifyComponent(directory, "orchestrator", platform, architecture)
}

// VerifyPlatform validates every executable component before setup invokes it.
// Metadata files outside those components are not executable inputs to setup.
func VerifyPlatform(directory, platform, architecture string) (map[string]*Manifest, error) {
	result := make(map[string]*Manifest, 3)
	var commit string
	for _, component := range []string{"orchestrator", "media-gateway", "sunshine"} {
		folder := filepath.Join(directory, component)
		info, err := os.Lstat(folder)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("missing or linked component directory: %s", component)
		}
		manifest, err := verifyComponent(folder, component, platform, architecture)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", component, err)
		}
		if commit != "" && manifest.Commit != commit {
			return nil, fmt.Errorf("platform components have different source revisions")
		}
		commit = manifest.Commit
		result[component] = manifest
	}
	return result, nil
}

func verifyComponent(directory, component, platform, architecture string) (*Manifest, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat("bundle-manifest.json")
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("missing or non-regular bundle manifest")
	}
	const maxManifest = 4 << 20
	if info.Size() > maxManifest {
		return nil, fmt.Errorf("bundle manifest is too large")
	}
	f, err := root.Open("bundle-manifest.json")
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	f.Close()
	if err != nil || len(data) > maxManifest {
		return nil, fmt.Errorf("cannot read bounded bundle manifest")
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("invalid bundle manifest: %w", err)
	}
	if manifest.Schema != 1 || manifest.Component != component || !digest(manifest.Commit, 20) || manifest.Dirty == nil || *manifest.Dirty {
		return nil, fmt.Errorf("bundle must be a versioned clean %s release", component)
	}
	if component == "orchestrator" && manifest.Version != "git-"+manifest.Commit[:12] {
		return nil, fmt.Errorf("bundle version does not match its source revision")
	}
	if component != "orchestrator" {
		if manifest.Platform == "win32" {
			manifest.Platform = "windows"
		}
		if manifest.Architecture == "x64" {
			manifest.Architecture = "amd64"
		}
	}
	if manifest.Platform != platform || manifest.Architecture != architecture || (platform != "windows" && platform != "linux") || (architecture != "amd64" && architecture != "arm64") {
		return nil, fmt.Errorf("bundle target does not match %s/%s", platform, architecture)
	}
	if len(manifest.Files) == 0 || len(manifest.Files) > 10000 {
		return nil, fmt.Errorf("invalid bundle file count")
	}
	entries := make(map[string]File, len(manifest.Files))
	names := make(map[string]bool, len(manifest.Files))
	for _, file := range manifest.Files {
		key := strings.ToLower(file.Path)
		if !validPath(file.Path) || key == "bundle-manifest.json" || names[key] || file.Bytes < 0 || !digest(file.SHA256, 32) {
			return nil, fmt.Errorf("invalid or duplicate bundle file entry")
		}
		names[key] = true
		entries[file.Path] = file
	}
	binary := component
	if component == "media-gateway" {
		binary = "web-server"
	}
	if platform == "windows" {
		binary += ".exe"
	}
	requiredFiles := []string{binary}
	switch component {
	case "orchestrator":
		requiredFiles = append(requiredFiles, "dist/index.html", "dist/THIRD_PARTY_NOTICES.json", "THIRD_PARTY_NOTICES.go.json")
	case "media-gateway":
		requiredFiles = append(requiredFiles, "dist/index.html", "LICENSE")
	case "sunshine":
		requiredFiles = append(requiredFiles, "assets/web/index.html", "LICENSE")
	default:
		return nil, fmt.Errorf("unsupported component %q", component)
	}
	for _, required := range requiredFiles {
		if file, ok := entries[required]; !ok || file.Bytes == 0 {
			return nil, fmt.Errorf("required bundle file missing: %s", required)
		}
	}
	err = fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if name == "." {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !validPath(name) || info.Mode()&os.ModeSymlink != 0 || (!info.Mode().IsRegular() && !info.IsDir()) {
			return fmt.Errorf("non-regular bundle entry: %s", name)
		}
		if info.IsDir() {
			return nil
		}
		if name == "bundle-manifest.json" {
			return nil
		}
		file, ok := entries[name]
		if !ok {
			return fmt.Errorf("unlisted bundle file: %s", name)
		}
		if info.Size() != file.Bytes {
			return fmt.Errorf("bundle file size mismatch: %s", name)
		}
		reader, err := root.Open(name)
		if err != nil {
			return err
		}
		hash := sha256.New()
		n, readErr := io.Copy(hash, io.LimitReader(reader, file.Bytes+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || n != file.Bytes || hex.EncodeToString(hash.Sum(nil)) != file.SHA256 {
			return fmt.Errorf("bundle file checksum mismatch: %s", name)
		}
		delete(entries, name)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(entries) != 0 {
		return nil, fmt.Errorf("bundle has missing files")
	}
	return &manifest, nil
}

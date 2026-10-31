package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxPlatformRequiresNativeExecutableAndAssetLayout(t *testing.T) {
	root := t.TempDir()
	clean := false
	for component, files := range map[string][]string{
		"orchestrator":  {"orchestrator", "dist/index.html", "dist/THIRD_PARTY_NOTICES.json", "THIRD_PARTY_NOTICES.go.json"},
		"media-gateway": {"web-server", "dist/index.html", "LICENSE"},
		"sunshine":      {"bin/sunshine", "share/sunshine/web/index.html", "LICENSE"},
	} {
		folder := filepath.Join(root, component)
		manifest := Manifest{Schema: 1, Component: component, Commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Version: "git-aaaaaaaaaaaa", Dirty: &clean, Platform: "linux", Architecture: "amd64"}
		for _, name := range files {
			file := filepath.Join(folder, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			data := []byte("native layout fixture " + name)
			if err := os.WriteFile(file, data, 0755); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(data)
			manifest.Files = append(manifest.Files, File{Path: name, Bytes: int64(len(data)), SHA256: hex.EncodeToString(digest[:])})
		}
		save(t, folder, manifest)
	}
	if _, err := VerifyPlatform(root, "linux", "amd64"); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "sunshine", "bin", "sunshine"), filepath.Join(root, "sunshine", "sunshine")); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyPlatform(root, "linux", "amd64"); err == nil {
		t.Fatal("accepted renderer outside its native verified layout")
	}
}

package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (string, Manifest) {
	t.Helper()
	dir := t.TempDir()
	manifest := Manifest{Schema: 1, Component: "orchestrator", Commit: strings.Repeat("a", 40), Version: "git-aaaaaaaaaaaa", Platform: "windows", Architecture: "amd64"}
	for _, name := range []string{"orchestrator.exe", "dist/index.html", "dist/THIRD_PARTY_NOTICES.json", "THIRD_PARTY_NOTICES.go.json"} {
		file := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		data := []byte("fixture-" + name)
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(data)
		manifest.Files = append(manifest.Files, File{Path: name, Bytes: int64(len(data)), SHA256: hex.EncodeToString(hash[:])})
	}
	save(t, dir, manifest)
	return dir, manifest
}

func save(t *testing.T, dir string, manifest Manifest) {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bundle-manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyBundleIntegrityAndTarget(t *testing.T) {
	dir, manifest := fixture(t)
	if got, err := Verify(dir, "windows", "amd64"); err != nil || got.Commit != manifest.Commit {
		t.Fatalf("valid bundle: %v", err)
	}
	if _, err := Verify(dir, "linux", "amd64"); err == nil {
		t.Fatal("wrong platform accepted")
	}
	if _, err := Verify(dir, "windows", "arm64"); err == nil {
		t.Fatal("wrong architecture accepted")
	}
	for _, mode := range []string{"checksum", "size", "missing", "extra", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			dir, _ := fixture(t)
			file := filepath.Join(dir, "dist", "index.html")
			var err error
			switch mode {
			case "checksum":
				data, _ := os.ReadFile(file)
				data[0] ^= 1
				err = os.WriteFile(file, data, 0600)
			case "size":
				err = os.WriteFile(file, []byte("wrong-size"), 0600)
			case "missing":
				err = os.Remove(file)
			case "extra":
				err = os.WriteFile(filepath.Join(dir, "unlisted.js"), []byte("extra"), 0600)
			case "symlink":
				err = os.Symlink(file, filepath.Join(dir, "linked.html"))
				if err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Verify(dir, "windows", "amd64"); err == nil {
				t.Fatal("modified bundle accepted")
			}
		})
	}
}

func TestInvalidBundleManifestNeverPasses(t *testing.T) {
	for _, mutate := range []func(*Manifest){
		func(m *Manifest) { m.Dirty = true }, func(m *Manifest) { m.Schema = 2 },
		func(m *Manifest) { m.Commit = "unknown" }, func(m *Manifest) { m.Files = nil },
		func(m *Manifest) { m.Files[0].Bytes = -1 }, func(m *Manifest) { m.Files[0].SHA256 = "bad" },
		func(m *Manifest) { m.Files[0].Path = "../outside" }, func(m *Manifest) { m.Files[0].Path = "C:/outside" },
		func(m *Manifest) { m.Files[0].Path = "dist\\index.html" }, func(m *Manifest) { m.Files[0].Path = "/outside" },
		func(m *Manifest) { m.Files[0].Path = "dist/index.html " },
		func(m *Manifest) { m.Files = append(m.Files, m.Files[0]) },
		func(m *Manifest) { f := m.Files[0]; f.Path = strings.ToUpper(f.Path); m.Files = append(m.Files, f) },
	} {
		dir, manifest := fixture(t)
		mutate(&manifest)
		save(t, dir, manifest)
		if _, err := Verify(dir, "windows", "amd64"); err == nil {
			t.Fatal("invalid manifest accepted")
		}
	}
}

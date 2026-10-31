package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestPlatformRequiresMatchingCompleteComponents(t *testing.T) {
	control, manifest := fixture(t)
	root := t.TempDir()
	if err := os.Rename(control, filepath.Join(root, "orchestrator")); err != nil {
		t.Fatal(err)
	}
	for component, names := range map[string][]string{
		"media-gateway": {"web-server.exe", "dist/index.html", "LICENSE", "WINDOWS-RUNTIME.json"},
		"sunshine":      {"sunshine.exe", "assets/web/index.html", "LICENSE"},
		"example":       {"checkerboard.exe", "audio-probe.exe", "THIRD_PARTY_NOTICES.go.json", "THIRD_PARTY_NOTICES.rust.json", "WINDOWS-RUNTIME.json"},
	} {
		folder := filepath.Join(root, component)
		m := manifest
		m.Component = component
		m.Platform = "win32"
		m.Architecture = "x64"
		m.Files = nil
		for _, name := range names {
			file := filepath.Join(folder, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			data := []byte("fixture " + name)
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(data)
			m.Files = append(m.Files, File{Path: name, Bytes: int64(len(data)), SHA256: hex.EncodeToString(digest[:])})
		}
		save(t, folder, m)
	}
	got, err := VerifyPlatform(root, "windows", "amd64")
	if err != nil || len(got) != 4 {
		t.Fatalf("valid platform: %v", err)
	}
	if err := os.Remove(filepath.Join(root, "example", "audio-probe.exe")); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyPlatform(root, "windows", "amd64"); err == nil {
		t.Fatal("example without its native audio helper accepted")
	}
	if err := os.RemoveAll(filepath.Join(root, "example")); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyPlatform(root, "windows", "amd64"); err != nil {
		t.Fatal("legacy three-component platform rejected", err)
	}
	changed := *got["sunshine"]
	changed.Commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	save(t, filepath.Join(root, "sunshine"), changed)
	if _, err := VerifyPlatform(root, "windows", "amd64"); err == nil {
		t.Fatal("mixed revisions accepted")
	}
	save(t, filepath.Join(root, "sunshine"), *got["sunshine"])
	if err := os.WriteFile(filepath.Join(root, "media-gateway", "web-server.exe"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyPlatform(root, "windows", "amd64"); err == nil {
		t.Fatal("tampered gateway accepted")
	}
}

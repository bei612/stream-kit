package audiodevice

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestDriverPackageRejectsTamperingAndNonRuntimeFiles(t *testing.T) {
	content := []byte("pinned signed bytes")
	digest := sha256.Sum256(content)
	profile := []driverFile{{Path: "driver.sys", Bytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:])}}
	for _, scenario := range []string{"valid", "changed", "missing", "extra", "directory", "case"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			name := filepath.Join(dir, "driver.sys")
			if err := os.WriteFile(name, content, 0600); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "changed":
				changed := append([]byte{}, content...)
				changed[0] ^= 1
				if err := os.WriteFile(name, changed, 0600); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			case "extra":
				if err := os.WriteFile(filepath.Join(dir, "audio-probe.exe"), []byte("test fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(name, 0700); err != nil {
					t.Fatal(err)
				}
			case "case":
				if err := os.Rename(name, filepath.Join(dir, "DRIVER.SYS")); err != nil {
					t.Fatal(err)
				}
			}
			err := verifyDriverFiles(dir, profile)
			if scenario == "valid" && err != nil {
				t.Fatal(err)
			}
			if scenario != "valid" && err == nil {
				t.Fatal("altered driver package was accepted")
			}
		})
	}
}

func TestPinnedUSBDriverPackageIncludesCompanionAndLicense(t *testing.T) {
	profile := pinnedDriverProfile()
	if profile.Version != "12.1.30.403" || len(profile.Files) != 7 {
		t.Fatal("unexpected driver package")
	}
	want := map[string]bool{"usbip2_ude.inf": false, "usbip2_ude.cat": false, "usbip2_ude.sys": false, "usbip2_filter.inf": false, "usbip2_filter.cat": false, "usbip2_filter.sys": false, "LICENSE.txt": false}
	for _, file := range profile.Files {
		seen, ok := want[file.Path]
		if !ok || seen || len(file.SHA256) != 64 || file.Bytes <= 0 {
			t.Fatalf("invalid file: %+v", file)
		}
		want[file.Path] = true
	}
}

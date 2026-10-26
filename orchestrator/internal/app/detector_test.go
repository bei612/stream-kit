package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsExeCandidate(t *testing.T) {
	yes := []string{"MyGame.exe", "app.EXE", "Game-Win64-Shipping.exe"}
	for _, name := range yes {
		t.Run("yes_"+name, func(t *testing.T) {
			if !isExeCandidate(name) {
				t.Errorf("expected true for %q", name)
			}
		})
	}

	no := []string{
		"CrashReportClient.exe", "crashreportclient.exe",
		"UE4PrereqSetup_x64.exe", "UnrealCEFSubProcess.exe",
		"readme.txt", "game.dll", "noextension",
	}
	for _, name := range no {
		t.Run("no_"+name, func(t *testing.T) {
			if isExeCandidate(name) {
				t.Errorf("expected false for %q", name)
			}
		})
	}
}

func TestValidatePEHeader(t *testing.T) {
	t.Run("valid MZ header", func(t *testing.T) {
		dir := t.TempDir()
		p := filepath.Join(dir, "test.exe")
		os.WriteFile(p, []byte{0x4D, 0x5A, 0x90, 0x00}, 0644)
		if err := ValidatePEHeader(p); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("invalid header", func(t *testing.T) {
		dir := t.TempDir()
		p := filepath.Join(dir, "test.exe")
		os.WriteFile(p, []byte{0x00, 0x00, 0x00, 0x00}, 0644)
		if err := ValidatePEHeader(p); err == nil {
			t.Error("expected error for non-PE file")
		}
	})

	t.Run("empty file", func(t *testing.T) {
		dir := t.TempDir()
		p := filepath.Join(dir, "empty.exe")
		os.WriteFile(p, []byte{}, 0644)
		if err := ValidatePEHeader(p); err == nil {
			t.Error("expected error for empty file")
		}
	})

	t.Run("nonexistent file", func(t *testing.T) {
		if err := ValidatePEHeader("/nonexistent/test.exe"); err == nil {
			t.Error("expected error for missing file")
		}
	})
}

func TestDetectEntryExe(t *testing.T) {
	t.Run("root exe", func(t *testing.T) {
		dir := t.TempDir()
		writeTestExe(t, filepath.Join(dir, "game.exe"))
		candidates, err := DetectEntryExe(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(candidates) != 1 || candidates[0].RelativePath != "game.exe" {
			t.Errorf("expected 1 candidate 'game.exe', got %v", candidates)
		}
	})

	t.Run("exe in subdirectory", func(t *testing.T) {
		dir := t.TempDir()
		sub := filepath.Join(dir, "bin")
		os.MkdirAll(sub, 0755)
		writeTestExe(t, filepath.Join(sub, "app.exe"))
		candidates, _ := DetectEntryExe(dir)
		if len(candidates) != 1 {
			t.Errorf("expected 1 candidate, got %d", len(candidates))
		}
	})

	t.Run("Engine/ directory skipped", func(t *testing.T) {
		dir := t.TempDir()
		eng := filepath.Join(dir, "Engine")
		os.MkdirAll(eng, 0755)
		writeTestExe(t, filepath.Join(eng, "ue.exe"))
		writeTestExe(t, filepath.Join(dir, "game.exe"))
		candidates, _ := DetectEntryExe(dir)
		if len(candidates) != 1 || candidates[0].RelativePath != "game.exe" {
			t.Errorf("Engine/ exe should be skipped, got %v", candidates)
		}
	})

	t.Run("excluded names skipped", func(t *testing.T) {
		dir := t.TempDir()
		writeTestExe(t, filepath.Join(dir, "CrashReportClient.exe"))
		writeTestExe(t, filepath.Join(dir, "game.exe"))
		candidates, _ := DetectEntryExe(dir)
		if len(candidates) != 1 || candidates[0].RelativePath != "game.exe" {
			t.Errorf("excluded exe should be skipped, got %v", candidates)
		}
	})

	t.Run("empty directory", func(t *testing.T) {
		dir := t.TempDir()
		candidates, _ := DetectEntryExe(dir)
		if len(candidates) != 0 {
			t.Errorf("expected 0 candidates, got %d", len(candidates))
		}
	})
}

func writeTestExe(t *testing.T, path string) {
	t.Helper()
	// Write minimal MZ header
	os.WriteFile(path, []byte{0x4D, 0x5A, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00}, 0644)
}

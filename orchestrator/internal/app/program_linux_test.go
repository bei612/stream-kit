package app

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestLinuxArchiveNativeEntryAndPermissions(t *testing.T) {
	// Actual host ELF plus a launcher in a Windows-created ZIP with no execute
	// metadata. No program is executed by discovery or selection preparation.
	binary, err := os.ReadFile("/bin/true")
	if err != nil {
		t.Fatal(err)
	}
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for name, data := range map[string][]byte{"Game/Binaries/Linux/Game": binary, "Launch.sh": nativeTestProgram(), "Game/Binaries/Linux/Wrong.exe": []byte("MZnot a Linux program")} {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0644)
		file, err := archive.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	archiveFile := filepath.Join(t.TempDir(), "linux.zip")
	if err := os.WriteFile(archiveFile, buffer.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Extract(archiveFile, root, ExtractConfig{MaxExtractSize: 2 << 20, MaxFileCount: 30}); err != nil {
		t.Fatal(err)
	}
	candidates, err := DetectEntryExe(root)
	if err != nil || len(candidates) != 2 {
		t.Fatalf("expected actual ELF and script, got %+v: %v", candidates, err)
	}
	for _, candidate := range candidates {
		before, err := os.Stat(candidate.FullPath)
		if err != nil || before.Mode().Perm()&0111 != 0 {
			t.Fatal("discovery changed execute permissions", err)
		}
		full, relative, err := resolveUploadedProgram(root, candidate.RelativePath, true)
		if err != nil || full != candidate.FullPath || relative != candidate.RelativePath {
			t.Fatal("native entry could not be selected", err)
		}
		after, err := os.Stat(full)
		if err != nil || after.Mode().Perm()&0100 == 0 || after.Mode().Perm()&0022 != 0 {
			t.Fatal("selection did not grant owner-only execution", err)
		}
	}
	if err := ValidateExePath(root, "Game/Binaries/Linux/Wrong.exe"); err == nil {
		t.Fatal("Windows PE accepted on Linux")
	}
}

func TestLinuxLocalFormatAndPermissionsRemainUnmodified(t *testing.T) {
	file := filepath.Join(t.TempDir(), "launch.sh")
	if err := os.WriteFile(file, nativeTestProgram(), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := canonicalLocalPath(file, false); err == nil {
		t.Fatal("local file without execution permission accepted")
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("local file permissions changed", err)
	}
	if err := os.Chmod(file, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := canonicalLocalPath(file, false); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("MZwrong platform"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := canonicalLocalPath(file, false); err == nil {
		t.Fatal("local Windows PE accepted on Linux")
	}
}

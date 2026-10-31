package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUploadedEntryCannotEscapeOwnedDirectory(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "managed")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(parent, "outside.exe")
	if err := os.WriteFile(outside, nativeTestProgram(), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../outside.exe", `..\outside.exe`, outside, "folder/../../outside.exe"} {
		if _, _, err := resolveUploadedProgram(root, name, true); err == nil {
			t.Fatalf("outside entry accepted: %q", name)
		}
	}
}

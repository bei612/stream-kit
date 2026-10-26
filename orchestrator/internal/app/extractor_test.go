package app

import (
	"strings"
	"testing"
)

func TestValidateEntryName_Valid(t *testing.T) {
	valid := []string{
		"game.exe",
		"subdir/file.txt",
		"deep/nested/path/file.dat",
		"file-with-dash.txt",
		"file_with_underscore.txt",
		"console.exe",
		"contact.txt",
		"auxiliary.dll",
	}
	for _, name := range valid {
		t.Run(name, func(t *testing.T) {
			if err := validateEntryName(name); err != nil {
				t.Errorf("expected valid, got error: %v", err)
			}
		})
	}
}

func TestValidateEntryName_PathTraversal(t *testing.T) {
	cases := []string{"../etc/passwd", "foo/../../bar", "foo/../bar", ".."}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			if err := validateEntryName(name); err == nil {
				t.Error("expected path traversal error, got nil")
			}
		})
	}
}

func TestValidateEntryName_AbsolutePath(t *testing.T) {
	if err := validateEntryName("/etc/passwd"); err == nil {
		t.Error("expected absolute path error, got nil")
	}
}

func TestValidateEntryName_NTFSColon(t *testing.T) {
	cases := []string{"file.txt:Zone.Identifier", "dir:stream/file"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			if err := validateEntryName(name); err == nil {
				t.Error("expected NTFS ADS error, got nil")
			}
		})
	}
}

func TestValidateEntryName_NTFSReserved(t *testing.T) {
	reserved := []string{
		"CON", "con.txt", "PRN", "prn.exe", "AUX", "NUL",
		"COM1", "com1.log", "LPT1", "lpt9.txt",
		"subdir/CON", "subdir/nul.exe",
	}
	for _, name := range reserved {
		t.Run(name, func(t *testing.T) {
			if err := validateEntryName(name); err == nil {
				t.Errorf("expected reserved name error for %q, got nil", name)
			}
		})
	}
}

func TestCheckPathLength(t *testing.T) {
	t.Run("within limit", func(t *testing.T) {
		if err := checkPathLength("/short/path", "file.txt"); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("exactly at limit", func(t *testing.T) {
		path := strings.Repeat("a", maxPathLen)
		if err := checkPathLength(path, "test"); err != nil {
			t.Errorf("expected nil at exactly limit, got: %v", err)
		}
	})

	t.Run("over limit", func(t *testing.T) {
		path := strings.Repeat("a", maxPathLen+1)
		if err := checkPathLength(path, "test"); err == nil {
			t.Error("expected error over limit, got nil")
		}
	})
}

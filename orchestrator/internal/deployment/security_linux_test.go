package deployment

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLinuxSetupUsesUnprivilegedRenderingIdentity(t *testing.T) {
	if err := validateSetupIdentity(Options{SessionID: 1, UserSID: "S-1-5-21-1"}); err == nil {
		t.Fatal("accepted Windows identity")
	}
	err := validateSetupIdentity(Options{})
	if (os.Geteuid() == 0 || os.Getuid() != os.Geteuid()) != (err != nil) {
		t.Fatalf("incorrect privilege decision: %v", err)
	}
}

func TestLinuxSetupProtectsOwnedDirectoriesAndRejectsLinkedOrSharedPaths(t *testing.T) {
	root := t.TempDir()
	owned := filepath.Join(root, "owned")
	if err := os.Mkdir(owned, 0755); err != nil {
		t.Fatal(err)
	}
	if err := protectDirectory(owned, "", true); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(owned)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("media directory permissions not private", err)
	}
	linked := filepath.Join(root, "linked")
	if err := os.Symlink(owned, linked); err != nil {
		t.Fatal(err)
	}
	if protectDirectory(linked, "", false) == nil {
		t.Fatal("accepted linked setup directory")
	}
	if protectDirectory(owned, "S-1-5-21-1", false) == nil {
		t.Fatal("accepted Windows SID")
	}
	if err := validateSetupParent(owned); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(owned, 0777); err != nil {
		t.Fatal(err)
	}
	if validateSetupParent(owned) == nil {
		t.Fatal("accepted writable shared data parent")
	}
	privateChild := filepath.Join(owned, "private-child")
	if err := os.Mkdir(privateChild, 0700); err != nil {
		t.Fatal(err)
	}
	if validateSetupParent(privateChild) == nil {
		t.Fatal("accepted a protected child beneath an unprotected ancestor")
	}
}

func TestLinuxPublicationNeverReplacesExistingDirectories(t *testing.T) {
	for _, occupied := range []bool{false, true} {
		root := t.TempDir()
		stage, data := filepath.Join(root, "stage"), filepath.Join(root, "data")
		for _, directory := range []string{stage, data} {
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
		}
		if occupied {
			if err := os.WriteFile(filepath.Join(data, "keep"), []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(stage, "new"), []byte("prepared"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := publishDirectory(stage, data); !errors.Is(err, unix.EEXIST) {
			t.Fatalf("publication did not reject existing directory: %v", err)
		}
		if _, err := os.Stat(filepath.Join(stage, "new")); err != nil {
			t.Fatal("lost staging data", err)
		}
		if _, err := os.Stat(filepath.Join(data, "new")); !os.IsNotExist(err) {
			t.Fatal("modified existing deployment")
		}
	}
	root := t.TempDir()
	stage, data := filepath.Join(root, "stage"), filepath.Join(root, "data")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := publishDirectory(stage, data); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(data); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatal("staging directory not published atomically")
	}
}

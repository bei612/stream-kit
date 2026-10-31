//go:build windows

package bundle

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWindowsDirectoryJunctionRejected(t *testing.T) {
	dir, _ := fixture(t)
	// Both directories belong to this test. The linked directory is outside the
	// bundle but contains no real user data; remove the link before cleanup.
	target := t.TempDir()
	link := filepath.Join(dir, "linked-directory")
	command := exec.Command("cmd.exe", "/c", "mklink", "/J", link, target)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create isolated junction: %v: %s", err, output)
	}
	defer os.Remove(link)
	if _, err := Verify(dir, "windows", "amd64"); err == nil {
		t.Fatal("directory junction accepted as a release entry")
	}
}

//go:build windows

package component

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"golang.org/x/sys/windows"
)

const snapshotTestInstance = "0123456789abcdef0123456789abcdef"
const snapshotTestUser = "S-1-5-21-1-2-3-1001"

func TestWorkerSnapshotLocksAndCleans(t *testing.T) {
	root := t.TempDir()
	cfg := config.ComponentConfig{ExePath: os.Args[0], WorkingDir: root}
	snapshot, err := writeWorkerLaunch(root, snapshotTestInstance, snapshotTestUser, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	if _, err := readWorkerLaunch(snapshot.path, snapshot.digest, snapshotTestInstance); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshot.path, []byte("replacement"), 0600); err == nil {
		t.Fatal("competing writer modified snapshot")
	}
	if _, err := writeWorkerLaunch(root, snapshotTestInstance, snapshotTestUser, cfg); err == nil {
		t.Fatal("adopted existing instance directory")
	}
	sd, err := windows.GetNamedSecurityInfo(snapshot.path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	acl := sd.String()
	if !strings.Contains(acl, "D:P") || !strings.Contains(acl, "(A;;FR;;;"+snapshotTestUser+")") || strings.Contains(acl, ";;;WD)") || strings.Contains(acl, ";;;AU)") {
		t.Fatalf("unexpected snapshot permissions: %s", acl)
	}
	path, directory := snapshot.path, snapshot.directory
	if err := snapshot.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{path, directory} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("snapshot remains: %s %v", path, err)
		}
	}
	if err := snapshot.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerSnapshotAbruptOwnerHelper(t *testing.T) {
	root := os.Getenv("STREAM_KIT_SNAPSHOT_TEST_ROOT")
	if root == "" {
		return
	}
	_, err := writeWorkerLaunch(root, snapshotTestInstance, snapshotTestUser, config.ComponentConfig{ExePath: os.Args[0], WorkingDir: root})
	if err != nil {
		os.Exit(51)
	}
	// Bypass every Go defer, as an abrupt process termination does.
	os.Exit(0)
}

func TestWorkerSnapshotKernelDeletesAfterOwnerExit(t *testing.T) {
	root := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWorkerSnapshotAbruptOwnerHelper$")
	cmd.Env = append(os.Environ(), "STREAM_KIT_SNAPSHOT_TEST_ROOT="+root)
	setPlatformAttrs(cmd)
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "worker-"+snapshotTestInstance)
	if _, err := os.Stat(directory); err != nil {
		t.Fatal("helper did not create snapshot directory", err)
	}
	if _, err := os.Stat(filepath.Join(directory, "launch.json")); !os.IsNotExist(err) {
		t.Fatal("snapshot survived owner exit", err)
	}
}

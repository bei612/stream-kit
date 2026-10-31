//go:build windows

package component

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func nativeTestWorker(marker string) (*nativeWorker, error) {
	return createSuspendedWorker(os.Args[0], []string{"-test.run=^TestNativeWorkerHelper$", "--", "branch", marker}, filepath.Dir(marker),
		func(app, command, directory *uint16, startup *windows.StartupInfo, process *windows.ProcessInformation) error {
			return windows.CreateProcess(app, command, nil, nil, false, windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW, nil, directory, startup, process)
		})
}

func TestNativeWorkerHelper(t *testing.T) {
	var role, marker string
	for i, arg := range os.Args {
		if arg == "--" && i+2 < len(os.Args) {
			role, marker = os.Args[i+1], os.Args[i+2]
			break
		}
	}
	if role == "" {
		return
	}
	switch role {
	case "owner":
		worker, err := nativeTestWorker(marker)
		if err != nil {
			os.Exit(21)
		}
		if err = os.WriteFile(marker+".worker", []byte(strconv.FormatUint(uint64(worker.pid), 10)), 0600); err != nil {
			os.Exit(22)
		}
		if err = worker.Resume(); err != nil {
			os.Exit(23)
		}
		// Deliberately no defer: the test terminates this owner abruptly.
	case "branch":
		cmd := exec.Command(os.Args[0], "-test.run=^TestNativeWorkerHelper$", "--", "leaf", marker)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Start(); err != nil {
			os.Exit(24)
		}
	case "leaf":
		if err := os.WriteFile(marker, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			os.Exit(25)
		}
	default:
		os.Exit(26)
	}
	for {
		time.Sleep(time.Second)
	}
}

func waitNativePID(t *testing.T, marker string) uint32 {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(marker)
		if err == nil {
			pid, err := strconv.ParseUint(string(data), 10, 32)
			if err == nil && pid != 0 {
				return uint32(pid)
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("native worker readiness timeout")
	return 0
}

func retainNativeProcess(t *testing.T, pid uint32) windows.Handle {
	t.Helper()
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(handle) })
	return handle
}

func assertNativeExited(t *testing.T, handles ...windows.Handle) {
	t.Helper()
	for _, handle := range handles {
		status, err := windows.WaitForSingleObject(handle, 5000)
		if err != nil || status != windows.WAIT_OBJECT_0 {
			t.Fatalf("process still running: status=%d error=%v", status, err)
		}
	}
}

func TestNativeWorkerSuspendedAndTreeCleanup(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "leaf.pid")
	worker, err := nativeTestWorker(marker)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worker.Close() })
	parent := retainNativeProcess(t, worker.pid)
	if status, err := windows.WaitForSingleObject(parent, 150); err != nil || status != uint32(windows.WAIT_TIMEOUT) {
		t.Fatalf("suspended process: %d %v", status, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("worker ran before Resume")
	}
	if err = worker.Resume(); err != nil {
		t.Fatal(err)
	}
	if err = worker.Resume(); err == nil {
		t.Fatal("duplicate Resume accepted")
	}
	child := retainNativeProcess(t, waitNativePID(t, marker))
	if err = worker.Close(); err != nil {
		t.Fatal(err)
	}
	assertNativeExited(t, parent, child)
	if err = worker.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeWorkerOwnerCrashKillsTree(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "leaf.pid")
	owner := exec.Command(os.Args[0], "-test.run=^TestNativeWorkerHelper$", "--", "owner", marker)
	owner.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := owner.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Process.Kill(); _ = owner.Wait() })
	worker := retainNativeProcess(t, waitNativePID(t, marker+".worker"))
	child := retainNativeProcess(t, waitNativePID(t, marker))
	if err := owner.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = owner.Wait()
	assertNativeExited(t, worker, child)
}

func TestNativeWorkerRequiresExplicitUserAndPaths(t *testing.T) {
	if _, err := startNativeWorker(0, 1, "S-1-5-18", os.Args[0], nil, t.TempDir()); err == nil {
		t.Fatal("implicit user accepted")
	}
	called := false
	_, err := createSuspendedWorker("relative.exe", nil, t.TempDir(), func(*uint16, *uint16, *uint16, *windows.StartupInfo, *windows.ProcessInformation) error {
		called = true
		return nil
	})
	if err == nil || called {
		t.Fatal("relative executable reached native launcher")
	}
}

func TestNativeWorkerClosedBeforeResumeNeverRuns(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "leaf.pid")
	worker, err := nativeTestWorker(marker)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worker.Close() })
	process := retainNativeProcess(t, worker.pid)
	if err := worker.Close(); err != nil {
		t.Fatal(err)
	}
	assertNativeExited(t, process)
	if err := worker.Resume(); err == nil {
		t.Fatal("closed worker resumed")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("aborted worker executed")
	}
}

//go:build windows

package component

import (
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func isProcessAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var exitCode uint32
	err = windows.GetExitCodeProcess(handle, &exitCode)
	return err == nil && exitCode == 259 // STILL_ACTIVE
}

func killOrphanProcess(pid int, timeoutSec int) {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	windows.TerminateProcess(handle, 1)
	windows.CloseHandle(handle)
	time.Sleep(1 * time.Second) // Windows Defender file handle release
}

func setPlatformAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
}

// stopProcess sends CTRL_BREAK, waits for Done, then TerminateProcess on timeout.
func stopProcess(mp *ManagedProcess, timeoutSec int) error {
	select {
	case <-mp.Done:
		return nil
	default:
	}
	pid := uint32(mp.PID)

	dll := windows.NewLazySystemDLL("kernel32.dll")
	proc := dll.NewProc("GenerateConsoleCtrlEvent")
	proc.Call(uintptr(windows.CTRL_BREAK_EVENT), uintptr(pid))

	select {
	case <-mp.Done:
		return nil
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		return forceStop(mp)
	}
}

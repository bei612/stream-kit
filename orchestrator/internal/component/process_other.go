//go:build !windows

package component

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func setPlatformAttrs(cmd *exec.Cmd) {}

func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

func killOrphanProcess(pid int, timeoutSec int) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	proc.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() {
		proc.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		proc.Kill()
	}
}

// stopProcess sends interrupt, waits for Done (set by RunWait), then force kills on timeout.
func stopProcess(mp *ManagedProcess, timeoutSec int) error {
	if mp.Cmd.Process != nil {
		mp.Cmd.Process.Signal(os.Interrupt)
	}

	select {
	case <-mp.Done:
		return nil
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		return forceStop(mp)
	}
}

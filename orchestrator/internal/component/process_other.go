//go:build !windows

package component

import (
	"fmt"
	"github.com/stream-kit/orchestrator/internal/config"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func checkLaunchContext(_ string, cfg config.ComponentConfig) error {
	if cfg.WindowsSessionID != 0 || cfg.WindowsUserSID != "" {
		return fmt.Errorf("Windows 用户会话配置不能用于当前服务端平台")
	}
	return nil
}

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

func (p *execProcess) interrupt() error { return p.cmd.Process.Signal(os.Interrupt) }

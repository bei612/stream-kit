//go:build windows

package component

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"golang.org/x/sys/windows"
)

// Direct child processes inherit this session. Session 0 cannot provide the
// interactive desktop required by our Sunshine capture backend. External
// renderers and the headless gateway are deliberately outside this check.
func checkLaunchContext(name string, cfg config.ComponentConfig) error {
	if name != "sunshine" || cfg.ExePath == "" {
		return nil
	}
	var sessionID uint32
	err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &sessionID)
	return validateRenderSession(sessionID, err)
}

func validateRenderSession(sessionID uint32, queryError error) error {
	if queryError != nil {
		return fmt.Errorf("无法确认渲染进程的 Windows 会话: %w", queryError)
	}
	if sessionID == 0 {
		return fmt.Errorf("当前控制服务位于 Windows Session 0，尚不支持从此会话直接启动交互式 Sunshine；需要受控的用户会话工作进程")
	}
	return nil
}

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

func (p *execProcess) interrupt() error {
	dll := windows.NewLazySystemDLL("kernel32.dll")
	proc := dll.NewProc("GenerateConsoleCtrlEvent")
	result, _, err := proc.Call(uintptr(windows.CTRL_BREAK_EVENT), uintptr(p.cmd.Process.Pid))
	if result == 0 {
		return err
	}
	return nil
}

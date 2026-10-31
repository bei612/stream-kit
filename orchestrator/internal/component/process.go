package component

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync/atomic"
	"time"

	"github.com/stream-kit/orchestrator/internal/commandline"
	"github.com/stream-kit/orchestrator/internal/config"

	"go.uber.org/zap"
)

// ownedProcessBackend must retain the actual process ownership until Wait
// completes. Implementations must never reacquire ownership from a bare PID.
type ownedProcessBackend interface {
	wait() (int, error)
	kill() error
	interrupt() error
}

type execProcess struct{ cmd *exec.Cmd }

func (p *execProcess) wait() (int, error) {
	err := p.cmd.Wait()
	if p.cmd.ProcessState != nil {
		return p.cmd.ProcessState.ExitCode(), err
	}
	return -1, err
}

func (p *execProcess) kill() error { return p.cmd.Process.Kill() }

// ManagedProcess represents an owned execution independently of its launcher.
type ManagedProcess struct {
	backend    ownedProcessBackend
	PID        int
	InstanceID string
	Stopping   atomic.Bool
	LogBuf     *RingBuffer
	ExitCode   int           // set by the single Wait() caller
	Done       chan struct{} // closed when process exits (Wait returns)
	outputs    []*lineLogWriter
}

// StartProcess launches a process with stdout/stderr capture.
func StartProcess(exePath, args, workingDir string, env map[string]string, logBuf *RingBuffer, logger *zap.Logger) (*ManagedProcess, error) {
	cmdArgs, err := commandline.Parse(args)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exePath, cmdArgs...)
	cmd.Dir = workingDir

	instance := make([]byte, 16)
	if _, err := rand.Read(instance); err != nil {
		return nil, err
	}
	instanceID := hex.EncodeToString(instance)
	cmd.Env = append(os.Environ(), mapToEnvSlice(env)...)
	cmd.Env = append(cmd.Env, "STREAM_KIT_PROCESS_INSTANCE="+instanceID)

	setPlatformAttrs(cmd)

	stdout := &lineLogWriter{buffer: logBuf}
	stderr := &lineLogWriter{buffer: logBuf, prefix: "[STDERR] "}
	// exec owns the copy workers; Wait joins them before closing Done.
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// A descendant may inherit a pipe after its parent exits. Do not let that
	// keep component ownership or service shutdown pending indefinitely.
	cmd.WaitDelay = 2 * time.Second

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	mp := &ManagedProcess{
		backend:    &execProcess{cmd: cmd},
		PID:        cmd.Process.Pid,
		InstanceID: instanceID,
		LogBuf:     logBuf,
		Done:       make(chan struct{}),
		outputs:    []*lineLogWriter{stdout, stderr},
	}

	return mp, nil
}

// RunWait calls cmd.Wait() exactly once, stores exit code, and closes Done channel.
// Must be called by exactly one goroutine (waitForExit in manager).
func (mp *ManagedProcess) RunWait() {
	exitCode, err := mp.backend.wait()
	for _, output := range mp.outputs {
		output.flush()
	}
	mp.ExitCode = exitCode
	if err != nil && exitCode == 0 {
		mp.ExitCode = -1
	}
	close(mp.Done)
}

// Kill terminates only the owned execution. RunWait still joins its output and
// publishes Done; callers needing that completion must wait for Done separately.
func (mp *ManagedProcess) Kill() error {
	select {
	case <-mp.Done:
		return nil
	default:
		return mp.backend.kill()
	}
}

// stopProcess keeps graceful stop and force-stop escalation launcher-independent.
func stopProcess(mp *ManagedProcess, timeoutSec int) error {
	select {
	case <-mp.Done:
		return nil
	default:
	}
	_ = mp.backend.interrupt()
	select {
	case <-mp.Done:
		return nil
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		return forceStop(mp)
	}
}

// WaitDone blocks until the process exits. Safe to call from multiple goroutines.
func (mp *ManagedProcess) WaitDone() int {
	<-mp.Done
	return mp.ExitCode
}

// forceStop uses the owned process handle and bounds the wait for RunWait.
// A failure must retain ownership in Manager rather than permit another launch.
func forceStop(mp *ManagedProcess) error {
	select {
	case <-mp.Done:
		return nil
	default:
	}
	if err := mp.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		select {
		case <-mp.Done:
			return nil
		default:
		}
		return fmt.Errorf("terminate managed process: %w", err)
	}
	select {
	case <-mp.Done:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("managed process did not exit after termination")
	}
}

// preflight uses the same native executable, environment and working directory.
// Output is discarded: diagnostics may include credentials or configuration.
func preflight(parent context.Context, cfg config.ComponentConfig) error {
	if parent.Err() != nil {
		return fmt.Errorf("组件原生配置预检已取消")
	}
	if _, err := commandline.Parse(cfg.Args); err != nil {
		return err
	}
	preflightArgs, err := commandline.Parse(cfg.PreflightArgs)
	if err != nil {
		return fmt.Errorf("组件预检参数无效: %w", err)
	}
	if cfg.PreflightArgs == "" {
		return nil
	}
	if cfg.ExePath == "" {
		return fmt.Errorf("组件预检需要可执行程序路径")
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cfg.ExePath, preflightArgs...)
	cmd.Dir = cfg.WorkingDir
	if len(cfg.Env) > 0 {
		cmd.Env = append(os.Environ(), mapToEnvSlice(cfg.Env)...)
	}
	setPlatformAttrs(cmd)
	if err := cmd.Run(); err != nil {
		if parent.Err() != nil {
			return fmt.Errorf("组件原生配置预检已取消")
		}
		if ctx.Err() != nil {
			return fmt.Errorf("组件原生配置预检超时")
		}
		return fmt.Errorf("组件原生配置预检失败，请检查配置及运行环境")
	}
	return nil
}

func mapToEnvSlice(env map[string]string) []string {
	result := make([]string, 0, len(env))
	for k, v := range env {
		result = append(result, k+"="+v)
	}
	return result
}

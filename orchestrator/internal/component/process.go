package component

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"

	"go.uber.org/zap"
)

// ManagedProcess represents a running child process.
type ManagedProcess struct {
	Cmd      *exec.Cmd
	PID      int
	Stopping atomic.Bool
	LogBuf   *RingBuffer
	ExitCode int           // set by the single Wait() caller
	Done     chan struct{} // closed when process exits (Wait returns)
}

// StartProcess launches a process with stdout/stderr capture.
func StartProcess(exePath, args, workingDir string, env map[string]string, logBuf *RingBuffer, logger *zap.Logger) (*ManagedProcess, error) {
	var cmdArgs []string
	if args != "" {
		cmdArgs = splitArgs(args)
	}
	cmd := exec.Command(exePath, cmdArgs...)
	cmd.Dir = workingDir

	if len(env) > 0 {
		cmd.Env = append(os.Environ(), mapToEnvSlice(env)...)
	}

	setPlatformAttrs(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	mp := &ManagedProcess{
		Cmd:    cmd,
		PID:    cmd.Process.Pid,
		LogBuf: logBuf,
		Done:   make(chan struct{}),
	}

	go captureOutput(stdout, logBuf, "")
	go captureOutput(stderr, logBuf, "[STDERR] ")

	return mp, nil
}

// RunWait calls cmd.Wait() exactly once, stores exit code, and closes Done channel.
// Must be called by exactly one goroutine (waitForExit in manager).
func (mp *ManagedProcess) RunWait() {
	err := mp.Cmd.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			mp.ExitCode = exitErr.ExitCode()
		} else {
			mp.ExitCode = -1
		}
	}
	close(mp.Done)
}

// WaitDone blocks until the process exits. Safe to call from multiple goroutines.
func (mp *ManagedProcess) WaitDone() int {
	<-mp.Done
	return mp.ExitCode
}

func captureOutput(r io.ReadCloser, buf *RingBuffer, prefix string) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		buf.Write(prefix + line)
	}
}

// splitArgs tokenizes a command-line string respecting double and single quotes.
func splitArgs(s string) []string {
	var args []string
	var cur strings.Builder
	inSingle, inDouble := false, false
	for _, r := range s {
		switch {
		case r == '\'' && !inDouble:
			inSingle = !inSingle
		case r == '"' && !inSingle:
			inDouble = !inDouble
		case r == ' ' && !inSingle && !inDouble:
			if cur.Len() > 0 {
				args = append(args, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		args = append(args, cur.String())
	}
	return args
}

func mapToEnvSlice(env map[string]string) []string {
	result := make([]string, 0, len(env))
	for k, v := range env {
		result = append(result, k+"="+v)
	}
	return result
}

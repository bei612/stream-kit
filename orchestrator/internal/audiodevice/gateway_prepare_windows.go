//go:build windows

package audiodevice

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// PrepareWindowsGateway owns a short-lived native initialization command. The
// gateway supplies only its effective device identity and holds an attachment
// only when requested. There are no HTTP listeners, streams or test signals.
func PrepareWindowsGateway(parent context.Context, executable string, args []string, directory string, environment map[string]string) (err error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = directory
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	cmd.Env = os.Environ()
	for k, v := range environment {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return err
	}
	cmd.Stderr = io.Discard // Configuration paths/errors must not disclose secrets.
	cmd.Cancel = func() error { return in.Close() }
	cmd.WaitDelay = 5 * time.Second
	if err = cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return err
	}
	var release func()
	defer func() {
		in.Close() // EOF releases the owned native attachment even after a failure.
		if waitErr := cmd.Wait(); waitErr != nil {
			err = errors.Join(err, fmt.Errorf("native audio preparation exited unsuccessfully: %w", waitErr))
		}
		if release != nil {
			release()
		}
	}()
	reader := bufio.NewScanner(out)
	reader.Buffer(make([]byte, 1024), 4096)
	var hello struct {
		SchemaVersion int             `json:"schema_version"`
		Identity      json.RawMessage `json:"identity"`
	}
	if err = readPreparationMessage(reader, &hello); err != nil {
		return err
	}
	if hello.SchemaVersion != 1 || len(hello.Identity) == 0 {
		return errors.New("unsupported native audio preparation protocol")
	}
	if bytes.Equal(hello.Identity, []byte("null")) {
		return nil
	}
	var id WindowsIdentity
	if err = strictPreparationJSON(hello.Identity, &id); err != nil {
		return err
	}
	if err = id.Validate(); err != nil {
		return err
	}
	ready, err := WindowsPolicyReady(id)
	if err != nil || ready {
		return err
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("new virtual audio device requires preparation by the platform service or an elevated installer")
	}
	// Cross-process serialization is scoped to this identity. A contender fails
	// before attachment; unrelated devices and configurations are independent.
	name := fmt.Sprintf(`Global\StreamKit.AudioPrepare.%x`, sha256.Sum256([]byte(strings.ToUpper(id.parent()))))
	mutex, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	// Windows mutex ownership is thread-bound, including across Go I/O waits.
	runtime.LockOSThread()
	wait, err := windows.WaitForSingleObject(mutex, 0)
	if err != nil {
		windows.CloseHandle(mutex)
		runtime.UnlockOSThread()
		return err
	}
	if wait != windows.WAIT_OBJECT_0 && wait != windows.WAIT_ABANDONED {
		windows.CloseHandle(mutex)
		runtime.UnlockOSThread()
		return errors.New("another process is preparing this virtual audio device")
	}
	release = func() { windows.ReleaseMutex(mutex); windows.CloseHandle(mutex); runtime.UnlockOSThread() }
	ready, err = WindowsPolicyReady(id)
	if err != nil || ready {
		return err
	}
	if _, err = io.WriteString(in, "attach\n"); err != nil {
		return err
	}
	var attached struct {
		SchemaVersion int  `json:"schema_version"`
		Attached      bool `json:"attached"`
	}
	if err = readPreparationMessage(reader, &attached); err != nil {
		return err
	}
	if attached.SchemaVersion != 1 || !attached.Attached {
		return errors.New("native audio attachment was not acknowledged")
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		n, queryErr := openPolicyNode(id, false)
		if queryErr == nil {
			queryErr = requireRunningAudioNode(n.device)
			n.close()
		}
		if queryErr == nil {
			break
		}
		if !errors.Is(queryErr, errAudioNodeMissing) {
			return queryErr
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("configured virtual audio interfaces did not enumerate")
		case <-tick.C:
		}
	}
	return PrepareWindowsPolicy(ctx, id)
}

func strictPreparationJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid native audio preparation message")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("extra native audio preparation data")
	}
	return nil
}

func readPreparationMessage(reader *bufio.Scanner, target any) error {
	if !reader.Scan() {
		return errors.New("native audio preparation ended before its bounded response")
	}
	return strictPreparationJSON(reader.Bytes(), target)
}

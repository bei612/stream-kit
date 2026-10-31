//go:build windows

package component

import (
	"errors"
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// nativeWorker retains the launch handles, never reacquiring them by PID.
// Its owner serializes Resume/Close and keeps it alive through peer validation.
// The unnamed, non-inherited job owns the worker and its ordinary descendants.
type nativeWorker struct {
	process windows.Handle
	thread  windows.Handle
	job     windows.Handle
	pid     uint32
}

// startNativeWorker requires a primary token selected by trusted service policy.
// It never substitutes SYSTEM or another session when the requested user fails.
// The process remains suspended until the caller explicitly resumes it.
func startNativeWorker(token windows.Token, exe string, args []string, dir string) (*nativeWorker, error) {
	if token == 0 {
		return nil, errors.New("worker requires an explicit user token")
	}
	var session, returned uint32
	if err := windows.GetTokenInformation(token, windows.TokenSessionId, (*byte)(unsafe.Pointer(&session)), uint32(unsafe.Sizeof(session)), &returned); err != nil {
		return nil, err
	}
	if returned != 4 || session == 0 {
		return nil, errors.New("worker requires an interactive user session")
	}
	var environment *uint16
	if err := windows.CreateEnvironmentBlock(&environment, token, false); err != nil {
		return nil, err
	}
	defer windows.DestroyEnvironmentBlock(environment)
	return createSuspendedWorker(exe, args, dir, func(app, command, directory *uint16, startup *windows.StartupInfo, process *windows.ProcessInformation) error {
		return windows.CreateProcessAsUser(token, app, command, nil, nil, false,
			windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW,
			environment, directory, startup, process)
	})
}

// createSuspendedWorker installs containment before any user code can execute.
// create must use CREATE_SUSPENDED and must not inherit handles. This private
// seam lets native tests verify containment without requiring service privileges.
func createSuspendedWorker(exe string, args []string, dir string,
	create func(*uint16, *uint16, *uint16, *windows.StartupInfo, *windows.ProcessInformation) error,
) (_ *nativeWorker, result error) {
	if !filepath.IsAbs(exe) || !filepath.IsAbs(dir) {
		return nil, errors.New("worker executable and working directory must be absolute")
	}
	app, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return nil, err
	}
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{exe}, args...)))
	if err != nil {
		return nil, err
	}
	directory, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil, err
	}
	desktop, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return nil, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	worker := &nativeWorker{job: job}
	defer func() {
		if result != nil {
			result = errors.Join(result, worker.Close())
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Desktop: desktop, Flags: windows.STARTF_USESHOWWINDOW, ShowWindow: windows.SW_HIDE}
	var process windows.ProcessInformation
	if err = create(app, command, directory, &startup, &process); err != nil {
		return nil, err
	}
	worker.process, worker.thread, worker.pid = process.Process, process.Thread, process.ProcessId
	if err = windows.AssignProcessToJobObject(job, process.Process); err != nil {
		// Assignment failed while suspended: terminate the owned process before
		// closing its handles, since the job cannot yet perform that cleanup.
		killErr := windows.TerminateProcess(process.Process, 1)
		if killErr == nil {
			var status uint32
			status, killErr = windows.WaitForSingleObject(process.Process, 5000)
			if killErr == nil && status != windows.WAIT_OBJECT_0 {
				killErr = fmt.Errorf("suspended worker termination did not complete: %d", status)
			}
		}
		return nil, errors.Join(err, killErr)
	}
	return worker, nil
}

func (worker *nativeWorker) Resume() error {
	if worker.thread == 0 {
		return errors.New("worker has already resumed or closed")
	}
	previous, err := windows.ResumeThread(worker.thread)
	if err != nil {
		return err
	}
	if previous != 1 {
		return fmt.Errorf("unexpected worker suspend count: %d", previous)
	}
	err = windows.CloseHandle(worker.thread)
	if err == nil {
		worker.thread = 0
	}
	return err
}

// Close kills the contained tree even if its worker stopped responding. The
// kernel also closes this non-inherited job when its owning service crashes.
func (worker *nativeWorker) Close() error {
	var result error
	for _, handle := range []*windows.Handle{&worker.job, &worker.thread, &worker.process} {
		if *handle != 0 {
			err := windows.CloseHandle(*handle)
			if err == nil {
				*handle = 0
			}
			result = errors.Join(result, err)
		}
	}
	return result
}

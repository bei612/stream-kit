//go:build windows

package workeripc

import (
	"errors"
	"golang.org/x/sys/windows"
)

// ControllerHandles contains handle values in the worker's handle table, not
// inheritable handles and not handles that can terminate or impersonate SYSTEM.
// The service publishes these values in its immutable per-launch directory
// before resuming that exact child. They are never accepted from the wire.
type ControllerHandles struct {
	Process uint64 `json:"process"`
	Token   uint64 `json:"token"`
}

func DelegateController(worker windows.Handle, token windows.Token) (ControllerHandles, error) {
	var process, query windows.Handle
	current := windows.CurrentProcess()
	if err := windows.DuplicateHandle(current, current, worker, &process, windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, 0); err != nil {
		return ControllerHandles{}, err
	}
	if err := windows.DuplicateHandle(current, windows.Handle(token), worker, &query, windows.TOKEN_QUERY, false, 0); err != nil {
		// Revoke only the handle just created in this retained child process.
		closeErr := windows.DuplicateHandle(worker, process, 0, nil, 0, false, windows.DUPLICATE_CLOSE_SOURCE)
		return ControllerHandles{}, errors.Join(err, closeErr)
	}
	return ControllerHandles{Process: uint64(process), Token: uint64(query)}, nil
}

// Open validates delegated handles against trusted launch metadata without
// attempting to reopen the privileged process by PID. Caller owns both handles
// even on failure and closes them when the worker exits.
func (handles ControllerHandles) Open(pid uint32, creation uint64) (windows.Handle, windows.Token, error) {
	process, token := windows.Handle(handles.Process), windows.Token(handles.Token)
	if uint64(process) != handles.Process || uint64(token) != handles.Token || process == 0 || process == windows.InvalidHandle || token == 0 || windows.Handle(token) == windows.InvalidHandle || pid == 0 || creation == 0 {
		return 0, 0, ErrPeerIdentity
	}
	actual, err := windows.GetProcessId(process)
	if err != nil || actual != pid || !processRunning(process) {
		return process, token, ErrPeerIdentity
	}
	created, err := ProcessCreation(process)
	if err != nil || created != creation {
		return process, token, ErrPeerIdentity
	}
	if _, err := token.GetTokenUser(); err != nil {
		return process, token, ErrPeerIdentity
	}
	return process, token, nil
}

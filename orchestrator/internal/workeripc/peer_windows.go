//go:build windows

package workeripc

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

var ErrPeerIdentity = errors.New("render worker pipe peer identity mismatch")

// ProcessCreation returns the native FILETIME value without conversion or loss
// of precision. The controller passes its own value in trusted launch metadata.
func ProcessCreation(process windows.Handle) (uint64, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}

// RetainPeerProcess opens the process named by trusted launch metadata exactly
// once and rejects a reused PID. Values learned from the pipe are not trusted
// bootstrap metadata. The caller retains and closes the handle after teardown.
func RetainPeerProcess(pid uint32, creation uint64) (windows.Handle, error) {
	if pid == 0 || creation == 0 {
		return 0, ErrPeerIdentity
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return 0, err
	}
	actual, err := ProcessCreation(process)
	if err != nil || actual != creation || !processRunning(process) {
		_ = windows.CloseHandle(process)
		return 0, ErrPeerIdentity
	}
	return process, nil
}

type PeerSide uint8

const (
	ClientPeer PeerSide = iota
	ServerPeer
)

// VerifyPeer requires the retained process handle from the trusted launch path,
// with QUERY_LIMITED_INFORMATION and SYNCHRONIZE rights. Neither the expected
// handle nor SID/session may come from a message sent by the peer. It does not
// close handles. The caller must keep the process handle until channel teardown.
// Named pipe creation must separately reject remote clients and restrict its ACL.
func VerifyPeer(pipe windows.Handle, side PeerSide, expectedProcess windows.Handle, expectedSID string, expectedSession uint32) error {
	// -1 is a current-process pseudo handle on Windows, not retained ownership.
	if expectedProcess == 0 || expectedProcess == windows.InvalidHandle {
		return ErrPeerIdentity
	}
	if side != ClientPeer && side != ServerPeer {
		return ErrPeerIdentity
	}
	sid, err := windows.StringToSid(expectedSID)
	if err != nil {
		return ErrPeerIdentity
	}
	if !processRunning(expectedProcess) {
		return ErrPeerIdentity
	}
	expectedPID, err := windows.GetProcessId(expectedProcess)
	if err != nil || expectedPID == 0 {
		return ErrPeerIdentity
	}
	var peerPID uint32
	if side == ClientPeer {
		err = windows.GetNamedPipeClientProcessId(pipe, &peerPID)
	} else {
		err = windows.GetNamedPipeServerProcessId(pipe, &peerPID)
	}
	if err != nil || peerPID != expectedPID {
		return ErrPeerIdentity
	}
	var token windows.Token
	if err := windows.OpenProcessToken(expectedProcess, windows.TOKEN_QUERY, &token); err != nil {
		return ErrPeerIdentity
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || !user.User.Sid.Equals(sid) {
		return ErrPeerIdentity
	}
	var session, returned uint32
	if err := windows.GetTokenInformation(token, windows.TokenSessionId, (*byte)(unsafe.Pointer(&session)), uint32(unsafe.Sizeof(session)), &returned); err != nil || returned != uint32(unsafe.Sizeof(session)) || session != expectedSession {
		return ErrPeerIdentity
	}
	// A process that exited during inspection cannot authorize a connection.
	if !processRunning(expectedProcess) {
		return ErrPeerIdentity
	}
	return nil
}

func processRunning(process windows.Handle) bool {
	status, err := windows.WaitForSingleObject(process, 0)
	return err == nil && status == uint32(windows.WAIT_TIMEOUT)
}

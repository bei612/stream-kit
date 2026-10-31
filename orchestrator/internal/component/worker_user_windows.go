//go:build windows

package component

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errWorkerUser = errors.New("render worker user/session identity mismatch")

// openWorkerUser selects exactly the configured session and SID. No console-
// session fallback is permitted: session IDs can be reused after sign-out.
// The caller owns the returned token and must close it after process creation.
func openWorkerUser(session uint32, sid string) (windows.Token, error) {
	return acquireWorkerUser(session, sid, activeWorkerSession, windows.WTSQueryUserToken)
}

func acquireWorkerUser(session uint32, sid string, active func(uint32) error, query func(uint32, *windows.Token) error) (windows.Token, error) {
	expected, err := windows.StringToSid(sid)
	if err != nil || session == 0 || session == ^uint32(0) || !interactiveWorkerSID(expected) {
		return 0, errWorkerUser
	}
	if err = active(session); err != nil {
		return 0, err
	}
	var token windows.Token
	if err = query(session, &token); err != nil {
		if token != 0 {
			_ = token.Close()
		}
		return 0, fmt.Errorf("query render user token: %w", err)
	}
	if err = validateWorkerUser(token, session, sid); err == nil {
		err = active(session)
	}
	if err != nil {
		_ = token.Close()
		return 0, err
	}
	return token, nil
}

func activeWorkerSession(session uint32) error {
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))
	if count > 0 && sessions == nil {
		return errWorkerUser
	}
	for _, entry := range unsafe.Slice(sessions, count) {
		if entry.SessionID == session && session != 0 && entry.State == windows.WTSActive {
			return nil
		}
	}
	return fmt.Errorf("render session %d is not active", session)
}

func interactiveWorkerSID(sid *windows.SID) bool {
	return sid != nil && !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinLocalServiceSid) && !sid.IsWellKnown(windows.WinNetworkServiceSid)
}

func validateWorkerUser(token windows.Token, session uint32, sid string) error {
	if token == 0 || session == 0 || session == ^uint32(0) {
		return errWorkerUser
	}
	expected, err := windows.StringToSid(sid)
	if err != nil || !interactiveWorkerSID(expected) {
		return errWorkerUser
	}
	user, err := token.GetTokenUser()
	if err != nil || !user.User.Sid.Equals(expected) {
		return errWorkerUser
	}
	for _, check := range []struct {
		class    uint32
		expected uint32
	}{
		{windows.TokenSessionId, session}, {windows.TokenType, windows.TokenPrimary},
	} {
		var value, returned uint32
		if err := windows.GetTokenInformation(token, check.class, (*byte)(unsafe.Pointer(&value)), 4, &returned); err != nil || returned != 4 || value != check.expected {
			return errWorkerUser
		}
	}
	return nil
}

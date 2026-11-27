//go:build windows

package component

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errWorkerUser = errors.New("render worker user/session identity mismatch")

func resolveWorkerSession(preferred uint32, sid string) (uint32, error) {
	expected, err := windows.StringToSid(sid)
	if err != nil || !interactiveWorkerSID(expected) {
		return 0, errWorkerUser
	}
	var entries *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &entries, &count); err != nil {
		return 0, err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(entries)))
	if count > 0 && entries == nil {
		return 0, errWorkerUser
	}
	var owned []uint32
	unresolved := false
	for _, entry := range unsafe.Slice(entries, count) {
		if entry.SessionID == 0 || entry.State != windows.WTSActive {
			continue
		}
		token, err := queryWorkerToken(entry.SessionID, windows.WTSQueryUserToken)
		if errors.Is(err, errSessionUnavailable) {
			unresolved = true
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("query active render session: %w", err)
		}
		valid := validateWorkerUser(token, entry.SessionID, sid) == nil
		token.Close()
		if valid {
			if entry.SessionID == preferred {
				return preferred, nil
			}
			owned = append(owned, entry.SessionID)
		}
	}
	// An active session can lose its token between enumeration and lookup.
	// Retry before choosing an alternate session whose uniqueness is uncertain.
	if unresolved {
		return 0, errSessionUnavailable
	}
	return chooseWorkerSession(preferred, owned)
}

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
	token, err := queryWorkerToken(session, query)
	if err != nil {
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

func queryWorkerToken(session uint32, query func(uint32, *windows.Token) error) (windows.Token, error) {
	var token windows.Token
	err := query(session, &token)
	if err == nil {
		return token, nil
	}
	if token != 0 {
		_ = token.Close()
	}
	// These results describe a disappearing or not-yet-logged-on session.
	// Retain permission errors and other failures as terminal diagnostics.
	switch {
	case errors.Is(err, windows.ERROR_NO_TOKEN), errors.Is(err, windows.ERROR_NO_SUCH_LOGON_SESSION),
		errors.Is(err, windows.ERROR_CTX_CLOSE_PENDING), errors.Is(err, windows.ERROR_CTX_WINSTATION_NOT_FOUND):
		return 0, fmt.Errorf("%w: %w", errSessionUnavailable, err)
	default:
		return 0, err
	}
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
	return fmt.Errorf("%w: session %d is not active", errSessionUnavailable, session)
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

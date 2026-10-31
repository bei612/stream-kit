//go:build windows

package component

import (
	"errors"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWorkerUserChecksActualTokenIdentity(t *testing.T) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	var session uint32
	if err = windows.ProcessIdToSessionId(uint32(os.Getpid()), &session); err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	allowed := session != 0 && interactiveWorkerSID(user.User.Sid)
	if err := validateWorkerUser(token, session, sid); (err == nil) != allowed {
		t.Fatalf("current token validation: %v", err)
	}
	for _, tc := range []struct {
		session uint32
		sid     string
	}{
		{0, sid}, {session + 1, sid}, {session, "S-1-5-18"}, {session, "S-1-5-19"}, {session, "S-1-5-20"}, {session, "invalid"},
	} {
		if err := validateWorkerUser(token, tc.session, tc.sid); !errors.Is(err, errWorkerUser) {
			t.Fatalf("accepted wrong identity: %+v %v", tc, err)
		}
	}
	if !allowed {
		return
	} // Service runners must reject their own Session 0 token.
	for _, failAfterQuery := range []bool{false, true} {
		activeCalls, queryCalls := 0, 0
		var issued windows.Token
		acquired, err := acquireWorkerUser(session, sid, func(got uint32) error {
			activeCalls++
			if got != session {
				t.Fatal("session fallback")
			}
			if failAfterQuery && activeCalls == 2 {
				return errors.New("session disconnected")
			}
			return nil
		}, func(got uint32, out *windows.Token) error {
			queryCalls++
			if got != session {
				t.Fatal("queried another session")
			}
			var duplicate windows.Handle
			err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(token), windows.CurrentProcess(), &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS)
			issued = windows.Token(duplicate)
			*out = issued
			return err
		})
		if activeCalls != 2 || queryCalls != 1 {
			t.Fatalf("calls: active=%d query=%d", activeCalls, queryCalls)
		}
		if failAfterQuery {
			if err == nil || acquired != 0 {
				t.Fatal("disconnected session accepted")
			}
			if _, err := issued.GetTokenUser(); err == nil {
				t.Fatal("failed acquisition leaked token")
			}
		} else {
			if err != nil || acquired != issued {
				t.Fatalf("acquisition: %v", err)
			}
			if _, err := acquired.GetTokenUser(); err != nil {
				t.Fatal("successful token prematurely closed")
			}
			_ = acquired.Close()
		}
	}
}

func TestWorkerUserRejectsBeforeTokenQuery(t *testing.T) {
	for _, sid := range []string{"", "invalid", "S-1-5-18", "S-1-5-19", "S-1-5-20"} {
		called := false
		_, err := acquireWorkerUser(1, sid, func(uint32) error { called = true; return nil }, func(uint32, *windows.Token) error { called = true; return nil })
		if err == nil || called {
			t.Fatalf("invalid user reached query: %s", sid)
		}
	}
	called := false
	_, err := acquireWorkerUser(1, "S-1-5-21-1-2-3-1001", func(uint32) error { return errors.New("inactive") }, func(uint32, *windows.Token) error { called = true; return nil })
	if err == nil || called {
		t.Fatal("inactive session queried")
	}
}

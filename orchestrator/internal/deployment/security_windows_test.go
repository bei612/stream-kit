//go:build windows

package deployment

import (
	"golang.org/x/sys/windows"
	"os"
	"testing"
)

func TestCurrentInteractiveIdentityUsesSessionOwner(t *testing.T) {
	var processSession uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &processSession); err != nil {
		t.Fatal(err)
	}
	if processSession == 0 {
		t.Skip("runner has no interactive session")
	}
	session, sid, err := CurrentRenderIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if session != processSession || sid == "" {
		t.Fatal("incorrect session identity")
	}
	if err := validateRenderUser(session, sid); err != nil {
		t.Fatal(err)
	}
	if err := validateRenderUser(session, "S-1-5-18"); err == nil {
		t.Fatal("accepted another account")
	}
}

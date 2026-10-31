//go:build windows

package workeripc

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"testing"
	"unsafe"
)

func TestDelegatedControllerHasOnlyNonInheritableQueryAuthority(t *testing.T) {
	var original windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &original); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	handles, err := DelegateController(windows.CurrentProcess(), original)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(windows.Handle(handles.Process))
	defer windows.CloseHandle(windows.Handle(handles.Token))
	created, err := ProcessCreation(windows.CurrentProcess())
	if err != nil {
		t.Fatal(err)
	}
	process, token, err := handles.Open(uint32(os.Getpid()), created)
	if err != nil || process == windows.CurrentProcess() {
		t.Fatal("delegated controller identity rejected", err)
	}
	for _, handle := range []windows.Handle{process, windows.Handle(token)} {
		var flags uint32
		ok, _, err := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetHandleInformation").Call(uintptr(handle), uintptr(unsafe.Pointer(&flags)))
		if ok == 0 {
			t.Fatal(err)
		}
		if flags&windows.HANDLE_FLAG_INHERIT != 0 {
			t.Fatal("authority is inheritable by rendered applications")
		}
		if _, err := windows.GetSecurityInfo(handle, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			t.Fatal("handle unexpectedly has READ_CONTROL access", err)
		}
	}
	var duplicate windows.Token
	if err := windows.DuplicateTokenEx(token, windows.TOKEN_QUERY, nil, windows.SecurityImpersonation, windows.TokenPrimary, &duplicate); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		if duplicate != 0 {
			duplicate.Close()
		}
		t.Fatal("query token unexpectedly permits token duplication", err)
	}
	for _, creation := range []uint64{0, created - 1, created + 1} {
		if _, _, err := handles.Open(uint32(os.Getpid()), creation); err == nil {
			t.Fatal("stale process identity accepted")
		}
	}
	if _, _, err := handles.Open(0, created); err == nil {
		t.Fatal("zero PID accepted")
	}
}

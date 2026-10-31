//go:build windows

package windowsservice

import (
	"golang.org/x/sys/windows"
	"testing"
)

func TestOwnershipRejectsOtherInstallation(t *testing.T) {
	expected := command(`C:\Program Files\StreamKit\orchestrator.exe`, `C:\ProgramData\StreamKit\config.json`)
	for _, tc := range []struct {
		name, actual, account string
		kind                  uint32
		valid                 bool
	}{
		{"owned", expected, "LocalSystem", windows.SERVICE_WIN32_OWN_PROCESS, true},
		{"other path", command(`D:\other\orchestrator.exe`, `C:\ProgramData\StreamKit\config.json`), "LocalSystem", windows.SERVICE_WIN32_OWN_PROCESS, false},
		{"other configuration", command(`C:\Program Files\StreamKit\orchestrator.exe`, `C:\other.json`), "LocalSystem", windows.SERVICE_WIN32_OWN_PROCESS, false},
		{"extra argument", expected + " --unknown", "LocalSystem", windows.SERVICE_WIN32_OWN_PROCESS, false},
		{"other identity", expected, "LocalService", windows.SERVICE_WIN32_OWN_PROCESS, false},
		{"shared process", expected, "LocalSystem", windows.SERVICE_WIN32_SHARE_PROCESS, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := checkOwner(tc.actual, tc.account, tc.kind, expected); (err == nil) != tc.valid {
				t.Fatalf("ownership: %v", err)
			}
		})
	}
	args, err := windows.DecomposeCommandLine(expected)
	if err != nil || len(args) != 3 || args[0] != `C:\Program Files\StreamKit\orchestrator.exe` || args[2] != `C:\ProgramData\StreamKit\config.json` {
		t.Fatalf("unsafe command quoting: %q, %v", args, err)
	}
}

func TestUnknownOperationDoesNotAccessSCM(t *testing.T) {
	if err := Apply("overwrite", "", ""); err == nil {
		t.Fatal("unknown operation accepted")
	}
}

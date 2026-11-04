//go:build windows

package windowsservice

import (
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Creates an isolated, never-started service. It cannot alter the production
// service or launch a second platform. CI runs elevated; ordinary local tests skip.
func TestInstalledStartupPolicyOnRealSCM(t *testing.T) {
	m, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CREATE_SERVICE)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		if os.Getenv("GITHUB_ACTIONS") == "true" {
			t.Fatal("Windows CI must execute real SCM policy verification elevated")
		}
		t.Skip("requires administrator for isolated SCM fixture")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseServiceHandle(m)
	name, _ := windows.UTF16PtrFromString(fmt.Sprintf("StreamKit-Startup-Test-%d-%d", os.Getpid(), time.Now().UnixNano()))
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	line, _ := windows.UTF16PtrFromString(command(binary, "unused-fixture.json"))
	s, err := windows.CreateService(m, name, name, windows.SERVICE_ALL_ACCESS,
		windows.SERVICE_WIN32_OWN_PROCESS, windows.SERVICE_DEMAND_START, windows.SERVICE_ERROR_NORMAL,
		line, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseServiceHandle(s)
	defer func() {
		if err := windows.DeleteService(s); err != nil {
			t.Error(err)
		}
	}()
	for _, initial := range []uint32{windows.SERVICE_DEMAND_START, windows.SERVICE_DISABLED, windows.SERVICE_AUTO_START} {
		if err := windows.ChangeServiceConfig(s, windows.SERVICE_NO_CHANGE, initial, windows.SERVICE_NO_CHANGE, nil, nil, nil, nil, nil, nil, nil); err != nil {
			t.Fatal(err)
		}
		if err := installStartupPolicy(s); err != nil {
			t.Fatal(err)
		}
		var needed uint32
		buf := make([]byte, 8192)
		cfg := (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buf[0]))
		if err := windows.QueryServiceConfig(s, cfg, uint32(len(buf)), &needed); err != nil {
			t.Fatal(err)
		}
		if cfg.StartType != windows.SERVICE_AUTO_START {
			t.Fatal("automatic startup not persisted")
		}
		if err := windows.QueryServiceConfig2(s, windows.SERVICE_CONFIG_FAILURE_ACTIONS, &buf[0], uint32(len(buf)), &needed); err != nil {
			t.Fatal(err)
		}
		recovery := (*windows.SERVICE_FAILURE_ACTIONS)(unsafe.Pointer(&buf[0]))
		if recovery.ResetPeriod != 86400 || recovery.ActionsCount != 3 {
			t.Fatal("recovery policy not persisted")
		}
		for i, action := range unsafe.Slice(recovery.Actions, recovery.ActionsCount) {
			if action.Type != windows.SC_ACTION_RESTART || action.Delay != []uint32{5000, 15000, 60000}[i] {
				t.Fatal("wrong recovery action")
			}
		}
		var status windows.SERVICE_STATUS
		if err := windows.QueryServiceStatus(s, &status); err != nil {
			t.Fatal(err)
		}
		if status.CurrentState != windows.SERVICE_STOPPED {
			t.Fatal("policy repair unexpectedly started service")
		}
	}
}

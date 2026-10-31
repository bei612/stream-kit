//go:build windows

// Package windowsservice owns the SCM lifecycle used by both interactive and
// unattended installation. It never changes a service belonging to another path.
package windowsservice

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const Name = "StreamKitOrchestrator"

func command(binary, config string) string {
	return windows.ComposeCommandLine([]string{binary, "--config", config})
}

func Apply(operation, binary, config string) error {
	if operation != "install" && operation != "start" && operation != "stop" && operation != "remove" {
		return fmt.Errorf("unsupported service operation %q", operation)
	}
	access := uint32(windows.SC_MANAGER_CONNECT)
	if operation == "install" {
		access |= windows.SC_MANAGER_CREATE_SERVICE
	}
	manager, err := windows.OpenSCManager(nil, nil, access)
	if err != nil {
		return fmt.Errorf("open service manager (installation requires administrator privileges): %w", err)
	}
	defer windows.CloseServiceHandle(manager)
	name, _ := windows.UTF16PtrFromString(Name)
	serviceAccess := uint32(windows.SERVICE_QUERY_CONFIG | windows.SERVICE_QUERY_STATUS)
	switch operation {
	case "install":
		serviceAccess |= windows.SERVICE_CHANGE_CONFIG | windows.SERVICE_START | windows.DELETE
	case "start":
		serviceAccess |= windows.SERVICE_START
	case "stop":
		serviceAccess |= windows.SERVICE_STOP
	case "remove":
		serviceAccess |= windows.SERVICE_STOP | windows.DELETE
	}
	service, err := windows.OpenService(manager, name, serviceAccess)
	created := false
	expected := command(binary, config)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		if operation == "remove" {
			return nil
		}
		if operation != "install" {
			return err
		}
		line, e := windows.UTF16PtrFromString(expected)
		if e != nil {
			return e
		}
		display, _ := windows.UTF16PtrFromString("Stream-Kit Orchestrator")
		service, err = windows.CreateService(manager, name, display, serviceAccess,
			windows.SERVICE_WIN32_OWN_PROCESS, windows.SERVICE_AUTO_START, windows.SERVICE_ERROR_NORMAL,
			line, nil, nil, nil, nil, nil)
		created = err == nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseServiceHandle(service)
	if err := verifyOwner(service, expected); err != nil {
		if created {
			_ = windows.DeleteService(service)
		}
		return err
	}
	switch operation {
	case "install":
		// Re-installation of an owned service is idempotent; it does not restart it.
		if err := recovery(service); err != nil {
			if created {
				return errors.Join(err, windows.DeleteService(service))
			}
			return err
		}
		return nil
	case "start":
		if err := windows.StartService(service, 0, nil); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
			return err
		}
		return waitState(service, windows.SERVICE_RUNNING)
	case "stop", "remove":
		var status windows.SERVICE_STATUS
		if err := windows.QueryServiceStatus(service, &status); err != nil {
			return err
		}
		if status.CurrentState != windows.SERVICE_STOPPED {
			if status.CurrentState != windows.SERVICE_STOP_PENDING {
				if err := windows.ControlService(service, windows.SERVICE_CONTROL_STOP, &status); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
					return err
				}
			}
			if err := waitState(service, windows.SERVICE_STOPPED); err != nil {
				return err
			}
		}
		if operation == "remove" {
			return windows.DeleteService(service)
		}
		return nil
	}
	return nil
}

func verifyOwner(service windows.Handle, expected string) error {
	var needed uint32
	err := windows.QueryServiceConfig(service, nil, 0, &needed)
	if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) || needed == 0 {
		return fmt.Errorf("query service ownership: %w", err)
	}
	buffer := make([]byte, needed)
	cfg := (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buffer[0]))
	if err := windows.QueryServiceConfig(service, cfg, needed, &needed); err != nil {
		return err
	}
	return checkOwner(windows.UTF16PtrToString(cfg.BinaryPathName), windows.UTF16PtrToString(cfg.ServiceStartName), cfg.ServiceType, expected)
}

func checkOwner(actual, account string, kind uint32, expected string) error {
	// Exact command ownership intentionally rejects aliases and extra arguments.
	if actual != expected || !strings.EqualFold(account, "LocalSystem") || kind != windows.SERVICE_WIN32_OWN_PROCESS {
		return fmt.Errorf("existing %s has a different binary, configuration, account or service type; explicit migration is required", Name)
	}
	return nil
}

func recovery(service windows.Handle) error {
	actions := []windows.SC_ACTION{{Type: windows.SC_ACTION_RESTART, Delay: 5000}, {Type: windows.SC_ACTION_RESTART, Delay: 15000}, {Type: windows.SC_ACTION_RESTART, Delay: 60000}}
	info := windows.SERVICE_FAILURE_ACTIONS{ResetPeriod: 86400, ActionsCount: uint32(len(actions)), Actions: &actions[0]}
	if err := windows.ChangeServiceConfig2(service, windows.SERVICE_CONFIG_FAILURE_ACTIONS, (*byte)(unsafe.Pointer(&info))); err != nil {
		return err
	}
	flag := windows.SERVICE_FAILURE_ACTIONS_FLAG{FailureActionsOnNonCrashFailures: 1}
	return windows.ChangeServiceConfig2(service, windows.SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, (*byte)(unsafe.Pointer(&flag)))
}

func waitState(service windows.Handle, wanted uint32) error {
	deadline := time.Now().Add(60 * time.Second)
	for {
		var status windows.SERVICE_STATUS
		if err := windows.QueryServiceStatus(service, &status); err != nil {
			return err
		}
		if status.CurrentState == wanted {
			return nil
		}
		if wanted == windows.SERVICE_RUNNING && status.CurrentState == windows.SERVICE_STOPPED {
			return fmt.Errorf("service stopped during startup (Windows code %d, service code %d)", status.Win32ExitCode, status.ServiceSpecificExitCode)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("service state %d did not reach %d within 60 seconds; no process was force-terminated", status.CurrentState, wanted)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

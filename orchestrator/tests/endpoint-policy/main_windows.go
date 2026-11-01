//go:build windows

// Developer experiment for the disposable GitHub Windows audio fixture only.
// This is not an installer command and is never part of a runtime bundle.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const parent = `USB\VID_FFFE&PID_0001\CIPolicyTarget`
const association = `{1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E},2`
const neverDefault = `{F3E80BEF-1723-4FF2-BCC4-7F83DC5E46D4},3`
const anyEndpoint = `{00000000-0000-0000-0000-000000000000}`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 1 || os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_ENVIRONMENT") != "github-hosted" || os.Getenv("RUNNER_OS") != "Windows" || !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("endpoint-policy experiment requires the elevated disposable GitHub Windows fixture")
	}
	media := windows.GUID{Data1: 0x4d36e96c, Data2: 0xe325, Data3: 0x11ce, Data4: [8]byte{0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18}}
	audio := windows.GUID{Data1: 0x6994ad04, Data2: 0x93ef, Data3: 0x11d0, Data4: [8]byte{0xa3, 0xcc, 0x00, 0xa0, 0xc9, 0x22, 0x31, 0x96}}
	parentKey := windows.DEVPROPKEY{FmtID: windows.DEVPROPGUID{Data1: 0x4340a6c5, Data2: 0x93fa, Data3: 0x4706, Data4: [8]byte{0x97, 0x2c, 0x7b, 0x64, 0x80, 0x08, 0xa5, 0xa7}}, PID: 8}
	set, err := windows.SetupDiGetClassDevsEx(&media, "", 0, 0, 0, "")
	if err != nil {
		return err
	}
	defer set.Close()
	open := windows.NewLazySystemDLL("cfgmgr32.dll").NewProc("CM_Open_Device_Interface_KeyW")
	keys := []registry.Key{}
	defer func() {
		for _, key := range keys {
			key.Close()
		}
	}()
	rows := []map[string]any{}
	var target *windows.DevInfoData
	for i := 0; ; i++ {
		dev, err := set.EnumDeviceInfo(i)
		if errors.Is(err, windows.ERROR_NO_MORE_ITEMS) {
			break
		}
		if err != nil {
			return err
		}
		p, err := windows.SetupDiGetDeviceProperty(set, dev, &parentKey)
		if err != nil || !strings.EqualFold(fmt.Sprint(p), parent) {
			continue
		}
		if target != nil {
			return errors.New("multiple audio nodes matched the fixture identity")
		}
		service, err := set.DeviceRegistryProperty(dev, windows.SPDRP_SERVICE)
		if err != nil || !strings.EqualFold(fmt.Sprint(service), "usbaudio2") {
			return errors.New("fixture must already use the Microsoft USB Audio 2 class driver")
		}
		target = dev
		id, err := set.DeviceInstanceID(dev)
		if err != nil {
			return err
		}
		links, err := windows.CM_Get_Device_Interface_List(id, &audio, windows.CM_GET_DEVICE_INTERFACE_LIST_ALL_DEVICES)
		if err != nil {
			return err
		}
		for _, link := range links {
			name, err := windows.UTF16PtrFromString(link)
			if err != nil {
				return err
			}
			var handle windows.Handle
			// The documented interface-key API supplies the handle. Do not
			// traverse implementation-specific Enum/DeviceClasses/MMDevices paths.
			status, _, _ := open.Call(uintptr(unsafe.Pointer(name)), uintptr(registry.READ|registry.WRITE), 1, uintptr(unsafe.Pointer(&handle)), 0)
			if status != 0 {
				return fmt.Errorf("open fixture interface policy: CONFIGRET %#x", status)
			}
			key := registry.Key(handle)
			keys = append(keys, key)
			// Only a fresh isolated fixture is eligible; existing policy is
			// never overwritten, even for the explicitly named test identity.
			existing, err := registry.OpenKey(key, `EP\0`, registry.READ)
			if err == nil {
				existing.Close()
				return errors.New("fixture endpoint policy already exists")
			}
			if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
				return err
			}
			rows = append(rows, map[string]any{"instance_id": id, "parent": parent, "interface": link})
		}
	}
	if len(keys) != 2 {
		return fmt.Errorf("expected two exact fixture interfaces, got %d", len(keys))
	}
	for i, key := range keys {
		if err := apply(key); err != nil {
			return err
		}
		rows[i]["render_never_default_mask"] = 0x107
	}
	// Endpoint metadata persists across disconnect/reconnect. Reinstall only
	// this exact synthetic node's existing inbox driver to invoke the documented
	// endpoint migration path; never update matching hardware IDs globally.
	if err := refresh(set, target); err != nil {
		return err
	}
	for _, row := range rows {
		row["inbox_driver_refreshed"] = true
	}
	return json.NewEncoder(os.Stdout).Encode(rows)
}

func refresh(set windows.DevInfo, device *windows.DevInfoData) error {
	var status, problem uint32
	if err := windows.CM_Get_DevNode_Status(&status, &problem, device.DevInst, 0); err != nil {
		return err
	}
	if problem != 0 || status&windows.DN_STARTED == 0 {
		return errors.New("fixture audio node must be present and running")
	}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		return err
	}
	params, err := set.DeviceInstallParams(device)
	if err != nil {
		return err
	}
	params.Flags |= windows.DI_ENUMSINGLEINF | windows.DI_QUIETINSTALL
	params.FlagsEx |= windows.DI_FLAGSEX_ALLOWEXCLUDEDDRVS
	if err := params.SetDriverPath(filepath.Join(root, "INF", "usbaudio2.inf")); err != nil {
		return err
	}
	if err := set.SetDeviceInstallParams(device, params); err != nil {
		return err
	}
	if err := set.BuildDriverInfoList(device, windows.SPDIT_COMPATDRIVER); err != nil {
		return err
	}
	defer set.DestroyDriverInfoList(device, windows.SPDIT_COMPATDRIVER)
	driver, err := set.EnumDriverInfo(device, windows.SPDIT_COMPATDRIVER, 0)
	if err != nil {
		return err
	}
	var reboot uint32
	install := windows.NewLazySystemDLL("newdev.dll").NewProc("DiInstallDevice")
	ok, _, callErr := install.Call(0, uintptr(set), uintptr(unsafe.Pointer(device)), uintptr(unsafe.Pointer(driver)), 0, uintptr(unsafe.Pointer(&reboot)))
	runtime.KeepAlive(device)
	runtime.KeepAlive(driver)
	if ok == 0 {
		return fmt.Errorf("refresh exact fixture inbox driver: %w", callErr)
	}
	if reboot != 0 {
		return errors.New("fixture refresh requires reboot; no restart performed")
	}
	return nil
}

func apply(key registry.Key) error {
	ep, exists, err := registry.CreateKey(key, `EP\0`, registry.READ|registry.WRITE)
	if err != nil {
		return err
	}
	defer ep.Close()
	if exists {
		return errors.New("fixture endpoint policy appeared concurrently")
	}
	// 0x100 selects only render; 0x7 covers all roles. Capture remains
	// selectable as a default input by recording applications and their owner.
	if err := ep.SetStringValue(association, anyEndpoint); err != nil {
		return err
	}
	if err := ep.SetDWordValue(neverDefault, 0x107); err != nil {
		return err
	}
	a, _, err := ep.GetStringValue(association)
	if err != nil {
		return err
	}
	n, _, err := ep.GetIntegerValue(neverDefault)
	if err != nil {
		return err
	}
	if a != anyEndpoint || n != 0x107 {
		return errors.New("fixture endpoint policy readback differs")
	}
	return nil
}

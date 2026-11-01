//go:build windows

package audiodevice

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const endpointAssociation = `{1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E},2`
const endpointNeverDefault = `{F3E80BEF-1723-4FF2-BCC4-7F83DC5E46D4},3`
const endpointAny = `{00000000-0000-0000-0000-000000000000}`
const policyStateKey = `StreamKit\AudioPolicy`

var errAudioNodeMissing = errors.New("configured virtual audio interfaces are not enumerated")

type policyNode struct {
	set    windows.DevInfo
	device *windows.DevInfoData
	keys   []registry.Key
}

func (n *policyNode) close() {
	for _, key := range n.keys {
		key.Close()
	}
	n.set.Close()
}

// openPolicyNode uses the documented device-interface API, never implementation
// paths under Enum, DeviceClasses or MMDevices. Only one exact configured USB
// parent and its two inbox audio interfaces are eligible.
func openPolicyNode(id WindowsIdentity, writable bool) (_ *policyNode, err error) {
	if err = id.Validate(); err != nil {
		return nil, err
	}
	media := windows.GUID{Data1: 0x4d36e96c, Data2: 0xe325, Data3: 0x11ce, Data4: [8]byte{0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18}}
	audio := windows.GUID{Data1: 0x6994ad04, Data2: 0x93ef, Data3: 0x11d0, Data4: [8]byte{0xa3, 0xcc, 0x00, 0xa0, 0xc9, 0x22, 0x31, 0x96}}
	parentKey := windows.DEVPROPKEY{FmtID: windows.DEVPROPGUID{Data1: 0x4340a6c5, Data2: 0x93fa, Data3: 0x4706, Data4: [8]byte{0x97, 0x2c, 0x7b, 0x64, 0x80, 0x08, 0xa5, 0xa7}}, PID: 8}
	set, err := windows.SetupDiGetClassDevsEx(&media, "", 0, 0, 0, "")
	if err != nil {
		return nil, err
	}
	n := &policyNode{set: set}
	defer func() {
		if err != nil {
			n.close()
		}
	}()
	access := uint32(registry.READ)
	if writable {
		access |= registry.WRITE
	}
	open := windows.NewLazySystemDLL("cfgmgr32.dll").NewProc("CM_Open_Device_Interface_KeyW")
	for i := 0; ; i++ {
		dev, e := set.EnumDeviceInfo(i)
		if errors.Is(e, windows.ERROR_NO_MORE_ITEMS) {
			break
		}
		if e != nil {
			return nil, e
		}
		parent, e := windows.SetupDiGetDeviceProperty(set, dev, &parentKey)
		if e != nil || !strings.EqualFold(fmt.Sprint(parent), id.parent()) {
			continue
		}
		if n.device != nil {
			return nil, errors.New("multiple audio nodes match the configured identity")
		}
		service, e := set.DeviceRegistryProperty(dev, windows.SPDRP_SERVICE)
		if errors.Is(e, windows.ERROR_INVALID_DATA) || errors.Is(e, windows.ERROR_FILE_NOT_FOUND) {
			return nil, errAudioNodeMissing
		}
		if e != nil || !strings.EqualFold(fmt.Sprint(service), "usbaudio2") {
			return nil, errors.New("configured audio device does not use the Microsoft USB Audio 2 class driver")
		}
		n.device = dev
		instance, e := set.DeviceInstanceID(dev)
		if e != nil {
			return nil, e
		}
		links, e := windows.CM_Get_Device_Interface_List(instance, &audio, windows.CM_GET_DEVICE_INTERFACE_LIST_ALL_DEVICES)
		if errors.Is(e, windows.CR_NO_SUCH_DEVNODE) || errors.Is(e, windows.ERROR_NO_SUCH_DEVICE_INTERFACE) {
			return nil, errAudioNodeMissing
		}
		if e != nil {
			return nil, fmt.Errorf("enumerate configured audio interfaces: %w", e)
		}
		for _, link := range links {
			if !strings.HasSuffix(strings.ToLower(link), `\msft_topo`) && !strings.HasSuffix(strings.ToLower(link), `\msft_wave`) {
				return nil, errors.New("unexpected configured audio interface")
			}
			name, e := windows.UTF16PtrFromString(link)
			if e != nil {
				return nil, e
			}
			var handle windows.Handle
			status, _, _ := open.Call(uintptr(unsafe.Pointer(name)), uintptr(access), 1, uintptr(unsafe.Pointer(&handle)), 0)
			runtime.KeepAlive(name)
			if status != 0 {
				return nil, fmt.Errorf("open configured audio interface: CONFIGRET %#x", status)
			}
			n.keys = append(n.keys, registry.Key(handle))
		}
	}
	if n.device == nil || len(n.keys) < 2 {
		return nil, errAudioNodeMissing
	}
	if len(n.keys) != 2 {
		return nil, errors.New("ambiguous configured audio interfaces")
	}
	return n, nil
}

func policyState(key registry.Key) (owned, complete bool, err error) {
	state, err := registry.OpenKey(key, policyStateKey, registry.READ)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	defer state.Close()
	version, _, err := state.GetIntegerValue("Version")
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return true, false, nil
	}
	if err != nil {
		return true, false, err
	}
	if version > 1 {
		return true, false, errors.New("newer audio policy preparation is not supported")
	}
	return true, version == 1, nil
}

func policyMatches(key registry.Key) (bool, error) {
	ep, err := registry.OpenKey(key, `EP\0`, registry.READ)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer ep.Close()
	a, _, err := ep.GetStringValue(endpointAssociation)
	if err != nil {
		return false, err
	}
	n, _, err := ep.GetIntegerValue(endpointNeverDefault)
	if err != nil {
		return false, err
	}
	return a == endpointAny && n == 0x107, nil
}

// WindowsPolicyReady is read-only and includes disconnected devices. A marker
// is written only after successful driver migration, not merely property writes.
func WindowsPolicyReady(id WindowsIdentity) (bool, error) {
	n, err := openPolicyNode(id, false)
	if errors.Is(err, errAudioNodeMissing) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer n.close()
	for _, key := range n.keys {
		_, complete, err := policyState(key)
		if err != nil {
			return false, err
		}
		if !complete {
			return false, nil
		}
		matches, err := policyMatches(key)
		if err != nil {
			return false, err
		}
		if !matches {
			return false, errors.New("prepared audio interface policy was modified")
		}
	}
	return true, nil
}

// PrepareWindowsPolicy runs with the native provider attached and no streams.
// It never selects system defaults or changes another device's driver. A failed
// operation leaves an incomplete marker so a retry cannot skip migration.
func PrepareWindowsPolicy(ctx context.Context, id WindowsIdentity) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ready, err := WindowsPolicyReady(id)
	if err != nil || ready {
		return err
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("virtual audio preparation requires the platform service or an elevated installer")
	}
	n, err := openPolicyNode(id, true)
	if err != nil {
		return err
	}
	defer n.close()
	if err := requireRunningAudioNode(n.device); err != nil {
		return err
	}
	// Validate every destination before the first mutation.
	for _, key := range n.keys {
		owned, _, err := policyState(key)
		if err != nil {
			return err
		}
		ep, err := registry.OpenKey(key, `EP`, registry.READ)
		if err == nil {
			ep.Close()
			if !owned {
				return errors.New("existing endpoint policy is not owned by Stream Kit")
			}
		} else if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return err
		}
	}
	for _, key := range n.keys {
		state, _, err := registry.CreateKey(key, policyStateKey, registry.READ|registry.WRITE)
		if err != nil {
			return err
		}
		err = state.SetDWordValue("Version", 0)
		state.Close()
		if err != nil {
			return err
		}
		ep, _, err := registry.CreateKey(key, `EP\0`, registry.READ|registry.WRITE)
		if err != nil {
			return err
		}
		err = ep.SetStringValue(endpointAssociation, endpointAny)
		if err == nil {
			err = ep.SetDWordValue(endpointNeverDefault, 0x107)
		}
		ep.Close()
		if err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := refreshInboxAudioDriver(n.set, n.device); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Refresh may replace interface registry handles. Reopen the exact node.
	updated, err := openPolicyNode(id, true)
	if err != nil {
		return err
	}
	defer updated.close()
	for _, key := range updated.keys {
		matches, err := policyMatches(key)
		if err != nil {
			return err
		}
		if !matches {
			return errors.New("audio policy did not survive driver refresh")
		}
		state, _, err := registry.CreateKey(key, policyStateKey, registry.READ|registry.WRITE)
		if err != nil {
			return err
		}
		err = state.SetDWordValue("Version", 1)
		state.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// Registered interfaces survive unplugging. Their presence alone must not end
// the attachment wait or allow policy writes/driver migration before PnP starts
// the new live node for this identity.
func requireRunningAudioNode(device *windows.DevInfoData) error {
	var status, problem uint32
	if err := windows.CM_Get_DevNode_Status(&status, &problem, device.DevInst, 0); err != nil {
		if errors.Is(err, windows.CR_NO_SUCH_DEVNODE) {
			return errAudioNodeMissing
		}
		return fmt.Errorf("inspect configured audio node: %w", err)
	}
	if problem != 0 || status&windows.DN_STARTED == 0 {
		return errAudioNodeMissing
	}
	return nil
}

func refreshInboxAudioDriver(set windows.DevInfo, device *windows.DevInfoData) error {
	if err := requireRunningAudioNode(device); err != nil {
		return err
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
	ok, _, callErr := installDevice.Call(0, uintptr(set), uintptr(unsafe.Pointer(device)), uintptr(unsafe.Pointer(driver)), 0, uintptr(unsafe.Pointer(&reboot)))
	runtime.KeepAlive(device)
	runtime.KeepAlive(driver)
	if ok == 0 {
		return fmt.Errorf("refresh configured inbox audio driver: %w", callErr)
	}
	if reboot != 0 {
		return errors.New("audio device preparation requires a manual reboot; no restart performed")
	}
	return nil
}

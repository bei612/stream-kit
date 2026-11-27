//go:build windows

package audiodevice

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	endpointMask    = 0x107 // Render default selection guard for all roles.
	variantUInt32   = 19
	variantCLSID    = 72
	endpointActive  = 1
	clsctxInProcess = 1
	flowRender      = 0
	flowCapture     = 1
)

var (
	containerIDProperty  = windows.DEVPROPKEY{FmtID: windows.DEVPROPGUID{Data1: 0x8c7ed206, Data2: 0x3f8a, Data3: 0x4827, Data4: [8]byte{0xb3, 0xab, 0xae, 0x9e, 0x1f, 0xae, 0xfc, 0x6c}}, PID: 2}
	neverDefaultProperty = windows.DEVPROPKEY{FmtID: windows.DEVPROPGUID{Data1: 0xf3e80bef, Data2: 0x1723, Data3: 0x4ff2, Data4: [8]byte{0xbc, 0xc4, 0x7f, 0x83, 0xdc, 0x5e, 0x46, 0xd4}}, PID: 3}
	mmDeviceClass        = windows.GUID{Data1: 0xbcde0395, Data2: 0xe52f, Data3: 0x467c, Data4: [8]byte{0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}}
	mmEnumeratorID       = windows.GUID{Data1: 0xa95664d2, Data2: 0x9614, Data3: 0x4f35, Data4: [8]byte{0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6}}
	deviceProperty       = windows.NewLazySystemDLL("cfgmgr32.dll").NewProc("CM_Get_DevNode_PropertyW")
	createCOMInstance    = windows.NewLazySystemDLL("ole32.dll").NewProc("CoCreateInstance")
	clearPropertyValue   = windows.NewLazySystemDLL("ole32.dll").NewProc("PropVariantClear")
)

// The SDK interfaces below are limited to read-only MMDevice enumeration and
// property stores. No endpoint is activated or selected as the system default.
type unknownMethods struct{ queryInterface, addRef, release uintptr }
type endpointEnumerator struct {
	vtable *struct {
		unknownMethods
		enumerate uintptr
	}
}
type endpointCollection struct {
	vtable *struct {
		unknownMethods
		count, item uintptr
	}
}
type audioEndpoint struct {
	vtable *struct {
		unknownMethods
		activate, openPropertyStore uintptr
	}
}
type endpointStore struct {
	vtable *struct {
		unknownMethods
		count, at, getValue uintptr
	}
}
type propertyValue struct {
	kind uint16
	_    [3]uint16
	data [2]uintptr // PROPVARIANT union, including count-and-pointer values.
}

func (v *propertyValue) clear() { clearPropertyValue.Call(uintptr(unsafe.Pointer(v))) }

func (v *propertyValue) matchesGUID(id windows.GUID) bool {
	if v.kind != variantCLSID || v.data[0] == 0 {
		return false
	}
	// The native store owns the GUID until PropVariantClear releases it.
	value := *(**windows.GUID)(unsafe.Pointer(&v.data[0]))
	return *value == id
}

func hresult(result uintptr) error {
	if int32(result) < 0 {
		return fmt.Errorf("HRESULT 0x%08x", uint32(result))
	}
	return nil
}

func audioNodeContainer(dev *windows.DevInfoData) (windows.GUID, error) {
	var id windows.GUID
	var kind windows.DEVPROPTYPE
	size := uint32(unsafe.Sizeof(id))
	status, _, _ := deviceProperty.Call(uintptr(dev.DevInst), uintptr(unsafe.Pointer(&containerIDProperty)),
		uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(&id)), uintptr(unsafe.Pointer(&size)), 0)
	if status != 0 {
		return id, fmt.Errorf("inspect configured audio container: CONFIGRET %#x", status)
	}
	if kind != windows.DEVPROP_TYPE_GUID || size != uint32(unsafe.Sizeof(id)) || id == (windows.GUID{}) {
		return id, errors.New("configured audio node has no valid container identity")
	}
	return id, nil
}

func effectiveEndpointPolicy(container windows.GUID) (bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const coinitMultithreaded = 0
	if err := windows.CoInitializeEx(0, coinitMultithreaded); err != nil && !errors.Is(err, syscall.Errno(1)) {
		return false, fmt.Errorf("initialize Core Audio: %w", err)
	}
	defer windows.CoUninitialize()
	var enumerator *endpointEnumerator
	result, _, _ := createCOMInstance.Call(uintptr(unsafe.Pointer(&mmDeviceClass)), 0, clsctxInProcess,
		uintptr(unsafe.Pointer(&mmEnumeratorID)), uintptr(unsafe.Pointer(&enumerator)))
	if err := hresult(result); err != nil {
		return false, fmt.Errorf("enumerate Core Audio endpoints: %w", err)
	}
	defer syscall.SyscallN(enumerator.vtable.release, uintptr(unsafe.Pointer(enumerator)))
	for _, flow := range []uintptr{flowRender, flowCapture} {
		ready, err := enumerator.protectedEndpoint(container, flow)
		if err != nil || !ready {
			return false, err
		}
	}
	return true, nil
}

func (e *endpointEnumerator) protectedEndpoint(container windows.GUID, flow uintptr) (bool, error) {
	var endpoints *endpointCollection
	result, _, _ := syscall.SyscallN(e.vtable.enumerate, uintptr(unsafe.Pointer(e)), flow, endpointActive, uintptr(unsafe.Pointer(&endpoints)))
	if err := hresult(result); err != nil {
		return false, err
	}
	defer syscall.SyscallN(endpoints.vtable.release, uintptr(unsafe.Pointer(endpoints)))
	var count uint32
	result, _, _ = syscall.SyscallN(endpoints.vtable.count, uintptr(unsafe.Pointer(endpoints)), uintptr(unsafe.Pointer(&count)))
	if err := hresult(result); err != nil {
		return false, err
	}
	found := false
	for index := uint32(0); index < count; index++ {
		belongs, protected, err := endpoints.endpointPolicy(index, container)
		if err != nil {
			return false, err
		}
		if belongs {
			if found || !protected {
				return false, nil
			}
			found = true
		}
	}
	return found, nil
}

func (c *endpointCollection) endpointPolicy(index uint32, container windows.GUID) (bool, bool, error) {
	var endpoint *audioEndpoint
	result, _, _ := syscall.SyscallN(c.vtable.item, uintptr(unsafe.Pointer(c)), uintptr(index), uintptr(unsafe.Pointer(&endpoint)))
	if err := hresult(result); err != nil {
		return false, false, err
	}
	defer syscall.SyscallN(endpoint.vtable.release, uintptr(unsafe.Pointer(endpoint)))
	var store *endpointStore
	result, _, _ = syscall.SyscallN(endpoint.vtable.openPropertyStore, uintptr(unsafe.Pointer(endpoint)), 0, uintptr(unsafe.Pointer(&store))) // STGM_READ
	if err := hresult(result); err != nil {
		return false, false, err
	}
	defer syscall.SyscallN(store.vtable.release, uintptr(unsafe.Pointer(store)))
	var id propertyValue
	defer id.clear()
	if err := store.read(&containerIDProperty, &id); err != nil {
		return false, false, err
	}
	if !id.matchesGUID(container) {
		return false, false, nil
	}
	var policy propertyValue
	defer policy.clear()
	if err := store.read(&neverDefaultProperty, &policy); err != nil {
		return false, false, err
	}
	return true, policy.kind == variantUInt32 && uint32(policy.data[0])&endpointMask == endpointMask, nil
}

func (s *endpointStore) read(key *windows.DEVPROPKEY, out *propertyValue) error {
	result, _, _ := syscall.SyscallN(s.vtable.getValue, uintptr(unsafe.Pointer(s)), uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(out)))
	return hresult(result)
}

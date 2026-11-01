//go:build windows

package audiodevice

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const usbHardwareID = `ROOT\USBIP_WIN2\UDE`

var usbClass = windows.GUID{Data1: 0x36fc9e60, Data2: 0xc465, Data3: 0x11cf, Data4: [8]byte{0x80, 0x56, 0x44, 0x45, 0x53, 0x54, 0, 0}}
var installDevice = windows.NewLazySystemDLL("newdev.dll").NewProc("DiInstallDevice")

// InstallWindowsDriver runs inside the unified elevated installer. DriverStore
// staging does not update/restart existing physical hubs. Device installation
// names only the root node created here, never all matching USB hardware.
func InstallWindowsDriver(ctx context.Context, directory string) (result DriverInstallation, err error) {
	if runtime.GOARCH != "amd64" {
		return result, fmt.Errorf("reviewed audio driver supports Windows amd64 only")
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		return result, err
	}
	if err = VerifyUSBDriverPackage(directory); err != nil {
		return result, err
	}
	profile := pinnedDriverProfile()
	result.DriverVersion = profile.Version
	if !windows.GetCurrentProcessToken().IsElevated() {
		return result, fmt.Errorf("audio driver installation must run in the elevated unified installer")
	}
	name, _ := windows.UTF16PtrFromString(`Global\StreamKitUSBAudioDriverInstall`)
	mutex, mutexErr := windows.CreateMutex(nil, false, name)
	if mutexErr != nil && !errors.Is(mutexErr, windows.ERROR_ALREADY_EXISTS) {
		return result, mutexErr
	}
	defer windows.CloseHandle(mutex)
	wait, waitErr := windows.WaitForSingleObject(mutex, 30000)
	if waitErr != nil {
		return result, waitErr
	}
	if wait != windows.WAIT_OBJECT_0 && wait != windows.WAIT_ABANDONED {
		return result, fmt.Errorf("another audio driver installation is in progress")
	}
	defer windows.ReleaseMutex(mutex)
	existing, err := existingUSBController(profile.Version)
	if err != nil {
		return result, err
	}
	if existing != "" {
		result.InstanceID = existing
		result.Reused = true
		// Do not replace or restart somebody else's existing controller. A
		// missing companion is a deployment error, not successful provisioning.
		for _, file := range profile.Files {
			if strings.HasSuffix(file.Path, ".sys") {
				if imageErr := verifyInstalledKernelImage(strings.TrimSuffix(file.Path, ".sys"), file); imageErr != nil {
					return result, imageErr
				}
			}
		}
		return result, nil
	}
	if err = installDevice.Find(); err != nil {
		return result, err
	}
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		return result, err
	}
	for _, inf := range []string{"usbip2_filter.inf", "usbip2_ude.inf"} {
		// /install is intentionally absent: staging must not update all hubs.
		cmd := exec.CommandContext(ctx, filepath.Join(systemDirectory, "pnputil.exe"), "/add-driver", filepath.Join(directory, inf))
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		output, stageErr := cmd.CombinedOutput()
		if stageErr != nil {
			var exit *exec.ExitError
			if errors.As(stageErr, &exit) && exit.ExitCode() == 3010 {
				result.RestartRequired = true
				continue
			}
			return result, fmt.Errorf("stage %s: %w: %s", inf, stageErr, strings.TrimSpace(string(output)))
		}
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	set, err := windows.SetupDiCreateDeviceInfoListEx(&usbClass, 0, "")
	if err != nil {
		return result, err
	}
	defer set.Close()
	device, err := set.CreateDeviceInfo("USB", &usbClass, "Stream Kit USB Audio Host Controller", 0, windows.DICD_GENERATE_ID)
	if err != nil {
		return result, err
	}
	if err = set.SetDeviceRegistryPropertyString(device, windows.SPDRP_HARDWAREID, usbHardwareID); err != nil {
		return result, err
	}
	params, err := set.DeviceInstallParams(device)
	if err != nil {
		return result, err
	}
	params.Flags |= windows.DI_ENUMSINGLEINF | windows.DI_QUIETINSTALL
	if err = params.SetDriverPath(filepath.Join(directory, "usbip2_ude.inf")); err != nil {
		return result, err
	}
	if err = set.SetDeviceInstallParams(device, params); err != nil {
		return result, err
	}
	if err = set.BuildDriverInfoList(device, windows.SPDIT_CLASSDRIVER); err != nil {
		return result, err
	}
	defer set.DestroyDriverInfoList(device, windows.SPDIT_CLASSDRIVER)
	driver, err := set.EnumDriverInfo(device, windows.SPDIT_CLASSDRIVER, 0)
	if err != nil {
		return result, err
	}
	if err = set.SetSelectedDriver(device, driver); err != nil {
		return result, err
	}
	if err = set.CallClassInstaller(windows.DIF_REGISTERDEVICE, device); err != nil {
		return result, err
	}
	// A failed install removes only this newly registered node. DriverStore
	// packages stay staged: they may already be shared by another application.
	defer func() {
		if err != nil {
			if cleanupErr := removeNewUSBNode(set, device); cleanupErr != nil {
				err = errors.Join(err, fmt.Errorf("remove newly created USB node: %w", cleanupErr))
			}
		}
	}()
	result.InstanceID, err = set.DeviceInstanceID(device)
	if err != nil {
		return result, err
	}
	var reboot uint32
	ok, _, nativeErr := installDevice.Call(0, uintptr(set), uintptr(unsafe.Pointer(device)), uintptr(unsafe.Pointer(driver)), 0, uintptr(unsafe.Pointer(&reboot)))
	runtime.KeepAlive(device)
	runtime.KeepAlive(driver)
	if ok == 0 {
		return result, fmt.Errorf("install selected USB host controller: %w", nativeErr)
	}
	result.RestartRequired = result.RestartRequired || reboot != 0
	params, err = set.DeviceInstallParams(device)
	if err != nil {
		return result, err
	}
	result.RestartRequired = result.RestartRequired || params.Flags&(windows.DI_NEEDREBOOT|windows.DI_NEEDRESTART) != 0
	return result, nil
}

func removeNewUSBNode(set windows.DevInfo, device *windows.DevInfoData) error {
	params := windows.RemoveDeviceParams{ClassInstallHeader: *windows.MakeClassInstallHeader(windows.DIF_REMOVE), Scope: windows.DI_REMOVEDEVICE_GLOBAL}
	if err := set.SetClassInstallParams(device, &params.ClassInstallHeader, uint32(unsafe.Sizeof(params))); err != nil {
		return err
	}
	return set.CallClassInstaller(windows.DIF_REMOVE, device)
}

func verifyInstalledKernelImage(service string, expected driverFile) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\`+service, registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf("required USB driver service %s is missing: %w", service, err)
	}
	image, _, err := key.GetStringValue("ImagePath")
	key.Close()
	if err != nil {
		return err
	}
	image, err = registry.ExpandString(image)
	if err != nil {
		return err
	}
	if strings.HasPrefix(strings.ToLower(image), `\systemroot\`) {
		root, rootErr := windows.GetWindowsDirectory()
		if rootErr != nil {
			return rootErr
		}
		image = filepath.Join(root, image[len(`\SystemRoot\`):])
	}
	image = strings.TrimPrefix(image, `\??\`)
	if !filepath.IsAbs(image) {
		return fmt.Errorf("driver service %s has a non-absolute image path", service)
	}
	if err = verifyDriverFile(image, expected); err != nil {
		return fmt.Errorf("existing %s differs from reviewed driver; not replaced: %w", service, err)
	}
	return nil
}

func existingUSBController(expectedVersion string) (string, error) {
	set, err := windows.SetupDiGetClassDevsEx(&usbClass, "", 0, 0, 0, "")
	if err != nil {
		return "", err
	}
	defer set.Close()
	var found string
	for i := 0; ; i++ {
		device, err := set.EnumDeviceInfo(i)
		if errors.Is(err, windows.ERROR_NO_MORE_ITEMS) {
			break
		}
		if err != nil {
			return "", err
		}
		property, err := set.DeviceRegistryProperty(device, windows.SPDRP_HARDWAREID)
		if errors.Is(err, windows.ERROR_INVALID_DATA) {
			continue
		}
		if err != nil {
			return "", err
		}
		ids, ok := property.([]string)
		if !ok {
			continue
		}
		matches := false
		for _, id := range ids {
			matches = matches || strings.EqualFold(id, usbHardwareID)
		}
		if !matches {
			continue
		}
		if found != "" {
			return "", fmt.Errorf("multiple USB/IP controllers found; refusing automatic replacement")
		}
		found, err = set.DeviceInstanceID(device)
		if err != nil {
			return "", err
		}
		var status, problem uint32
		if err = windows.CM_Get_DevNode_Status(&status, &problem, device.DevInst, 0); err != nil {
			return "", err
		}
		if problem != 0 || status&windows.DN_STARTED == 0 {
			return "", fmt.Errorf("existing USB/IP controller is not running (problem %d); no duplicate will be installed", problem)
		}
		property, err = set.DeviceRegistryProperty(device, windows.SPDRP_DRIVER)
		if err != nil {
			return "", err
		}
		driverKey, ok := property.(string)
		if !ok || !strings.HasPrefix(strings.ToLower(driverKey), "{36fc9e60-c465-11cf-8056-444553540000}\\") {
			return "", fmt.Errorf("unexpected USB controller driver registration")
		}
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Class\`+driverKey, registry.QUERY_VALUE)
		if err != nil {
			return "", err
		}
		version, _, readErr := key.GetStringValue("DriverVersion")
		key.Close()
		if readErr != nil {
			return "", readErr
		}
		if version != expectedVersion {
			return "", fmt.Errorf("existing USB controller version %s differs from reviewed %s; no replacement performed", version, expectedVersion)
		}
	}
	return found, nil
}

//go:build !windows

package audiodevice

import (
	"context"
	"fmt"
)

func InstallWindowsDriver(context.Context, string) (DriverInstallation, error) {
	return DriverInstallation{}, fmt.Errorf("USB audio driver installation is supported on Windows only")
}

package app

import (
	"math"
	"strings"

	"golang.org/x/sys/windows"
)

func archiveFSAvailable(directory string) (int64, error) {
	// The native API requires a trailing separator for UNC shares.
	name, err := windows.UTF16PtrFromString(strings.TrimRight(directory, `\/`) + `\`)
	if err != nil {
		return 0, err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(name, &available, nil, nil); err != nil {
		return 0, err
	}
	return int64(min(available, math.MaxInt64)), nil
}

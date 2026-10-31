//go:build !windows

package windowsservice

import "fmt"

func Apply(operation, binary, config string) error {
	return fmt.Errorf("Windows service commands are available only on Windows; use the supplied systemd unit on Linux")
}

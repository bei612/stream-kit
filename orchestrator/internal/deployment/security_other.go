//go:build !windows

package deployment

import "fmt"

func CurrentRenderIdentity() (uint32, string, error) {
	return 0, "", fmt.Errorf("automatic platform setup requires Windows")
}
func validateRenderUser(session uint32, sid string) error {
	return fmt.Errorf("automatic platform setup requires Windows")
}

func requireAdministrator() error { return fmt.Errorf("automatic platform setup requires Windows") }
func protectDirectory(directory, sid string, media bool) error {
	return fmt.Errorf("automatic platform setup requires Windows")
}

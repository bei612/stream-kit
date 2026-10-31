//go:build !windows && !linux

package deployment

import "fmt"

func CurrentRenderIdentity() (uint32, string, error) {
	return 0, "", fmt.Errorf("automatic platform setup requires Windows or Linux")
}
func protectDirectory(directory, sid string, media bool) error {
	return fmt.Errorf("automatic platform setup requires Windows or Linux")
}

func validateSetupIdentity(Options) error {
	return fmt.Errorf("automatic platform setup requires Windows or Linux")
}
func publishDirectory(string, string) error {
	return fmt.Errorf("automatic platform setup requires Windows or Linux")
}

func validateSetupParent(string) error {
	return fmt.Errorf("automatic platform setup requires Windows or Linux")
}

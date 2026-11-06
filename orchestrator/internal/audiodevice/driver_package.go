package audiodevice

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ErrRestartRequired means Windows accepted an owned device change but requires
// a manual restart before it can be used. Installers must retain autostart and
// report this separately from both readiness and failed installation.
var ErrRestartRequired = errors.New("audio device preparation requires a manual reboot; no restart performed")

// The native installer and packaging tools share this exact reviewed inventory.
// Both the host controller and its companion filter are required: the latter
// forwards configuration/alternate-interface selection to the USB/IP server.
//
//go:embed usbip-driver.json
var usbDriverProfile []byte

type driverFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type driverProfile struct {
	Version string       `json:"driver_version"`
	Files   []driverFile `json:"files"`
}

type DriverInstallation struct {
	InstanceID      string `json:"instance_id"`
	Reused          bool   `json:"reused"`
	RestartRequired bool   `json:"restart_required"`
	DriverVersion   string `json:"driver_version"`
}

func pinnedDriverProfile() driverProfile {
	var profile driverProfile
	if err := json.Unmarshal(usbDriverProfile, &profile); err != nil {
		panic(err)
	}
	return profile
}

// VerifyUSBDriverPackage performs no installation. Only the pinned vendor
// files and license are accepted; no executables, tests or SDK are packaged.
func VerifyUSBDriverPackage(directory string) error {
	return verifyDriverFiles(directory, pinnedDriverProfile().Files)
}
func verifyDriverFiles(directory string, files []driverFile) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("driver package must be a regular directory")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) != len(files) {
		return fmt.Errorf("driver package inventory differs from reviewed package")
	}
	actualNames := make(map[string]bool, len(entries))
	for _, entry := range entries {
		actualNames[entry.Name()] = true
	}
	for _, expected := range files {
		if filepath.Base(expected.Path) != expected.Path {
			return fmt.Errorf("invalid embedded driver inventory")
		}
		if !actualNames[expected.Path] {
			return fmt.Errorf("driver package filename differs: %s", expected.Path)
		}
		name := filepath.Join(directory, expected.Path)
		if err := verifyDriverFile(name, expected); err != nil {
			return err
		}
	}
	return nil
}
func verifyDriverFile(name string, expected driverFile) error {
	info, err := os.Lstat(name)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != expected.Bytes {
		return fmt.Errorf("driver package file differs: %s", expected.Path)
	}
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	hash := sha256.New()
	count, readErr := io.Copy(hash, io.LimitReader(f, expected.Bytes+1))
	closeErr := f.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	if count != expected.Bytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("driver package digest differs: %s", expected.Path)
	}
	return nil
}

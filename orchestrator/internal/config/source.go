package config

import (
	"io"
	"os"
)

// maxConfigBytes applies to the actual file, including formatting, on both
// startup and management reads. A saved configuration must remain readable.
const maxConfigBytes = 1 << 20

func readConfigSource(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrSettingsUnavailable
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, ErrSettingsUnavailable
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() > maxConfigBytes {
		return nil, ErrSettingsUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes {
		return nil, ErrSettingsUnavailable
	}
	return data, nil
}

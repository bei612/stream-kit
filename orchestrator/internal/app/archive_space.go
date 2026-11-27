package app

import (
	"errors"
	"math"
	"os"
	"path/filepath"
)

var ErrArchiveSpace = errors.New("服务器存储空间不足")

type ArchiveStorageSpace struct {
	StagingBytes      *int64 `json:"staging_available_bytes,omitempty"`
	ApplicationsBytes *int64 `json:"applications_available_bytes,omitempty"`
	ReserveBytes      int64  `json:"reserve_bytes"`
}

// ArchiveStorage reports available space without creating pending storage paths.
func (m *Manager) ArchiveStorage() ArchiveStorageSpace {
	return ArchiveStorageSpace{
		StagingBytes:      availableArchiveStorage(m.config.Storage.TempDir),
		ApplicationsBytes: availableArchiveStorage(m.config.Storage.AppsDir),
		ReserveBytes:      m.config.Storage.MinFreeSpace,
	}
}

func archiveWriteBudget(directory string, reserve int64) (int64, error) {
	free, err := archiveFSAvailable(directory)
	return max(0, free-reserve), err
}

func availableArchiveStorage(directory string) *int64 {
	if directory == "" {
		return nil
	}
	directory, err := filepath.Abs(directory)
	if err != nil {
		return nil
	}
	for {
		info, err := os.Stat(directory)
		if err == nil && info.IsDir() {
			free, err := archiveFSAvailable(directory)
			if err == nil && free < math.MaxInt64 {
				return &free
			}
			return nil
		}
		parent := filepath.Dir(directory)
		if !os.IsNotExist(err) || parent == directory {
			return nil
		}
		directory = parent
	}
}

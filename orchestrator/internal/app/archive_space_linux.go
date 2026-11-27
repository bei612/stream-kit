package app

import (
	"errors"
	"math"

	"golang.org/x/sys/unix"
)

func archiveFSAvailable(directory string) (int64, error) {
	var usage unix.Statfs_t
	if err := unix.Statfs(directory, &usage); err != nil {
		return 0, err
	}
	blockSize := usage.Frsize
	if blockSize <= 0 {
		blockSize = usage.Bsize
	}
	if blockSize <= 0 {
		return 0, errors.New("无法读取磁盘块大小")
	}
	if usage.Bavail > uint64(math.MaxInt64)/uint64(blockSize) {
		return math.MaxInt64, nil
	}
	return int64(usage.Bavail * uint64(blockSize)), nil
}

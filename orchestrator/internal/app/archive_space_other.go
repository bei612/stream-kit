//go:build !windows && !linux

package app

import "math"

func archiveFSAvailable(string) (int64, error) { return math.MaxInt64, nil }

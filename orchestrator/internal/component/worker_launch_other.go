//go:build !windows

package component

import "os"

func openWorkerLaunch(path string) (*os.File, error) { return os.Open(path) }

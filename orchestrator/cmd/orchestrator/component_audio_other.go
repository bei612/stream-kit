//go:build !windows

package main

import (
	"context"
	"errors"

	"github.com/stream-kit/orchestrator/internal/config"
)

// Linux audio resources follow the existing systemd user-service preparation.
func prepareComponentAudio(context.Context, string, config.ComponentConfig) error { return nil }

func restoreLegacyComponentAudio(context.Context, string, config.ComponentConfig) error {
	return errors.New("legacy endpoint policy is only supported on Windows")
}

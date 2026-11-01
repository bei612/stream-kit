//go:build !windows

package main

import (
	"context"
	"github.com/stream-kit/orchestrator/internal/config"
)

// Linux audio resources follow the existing systemd user-service preparation.
func prepareComponentAudio(context.Context, string, config.ComponentConfig) error { return nil }

//go:build windows

package main

import (
	"context"
	"fmt"

	"github.com/stream-kit/orchestrator/internal/audiodevice"
	"github.com/stream-kit/orchestrator/internal/commandline"
	"github.com/stream-kit/orchestrator/internal/config"
)

func prepareComponentAudio(ctx context.Context, name string, cfg config.ComponentConfig) error {
	// Unified Windows deployments launch media in the configured desktop
	// session. Their controller retains installation privileges for device
	// preparation; media execution keeps the interactive user's identity.
	if name != "web_server" || cfg.ExePath == "" || cfg.WindowsUserSID == "" {
		return nil
	}
	args, err := commandline.Parse(cfg.PreflightArgs)
	if err != nil {
		return err
	}
	if len(args) < 2 || args[len(args)-2] != "config" || args[len(args)-1] != "check" {
		return fmt.Errorf("managed gateway requires its native configuration preflight before audio preparation")
	}
	args = append(args[:len(args)-2], "prepare-audio")
	return audiodevice.PrepareWindowsGateway(ctx, cfg.ExePath, args, cfg.WorkingDir, cfg.Env)
}

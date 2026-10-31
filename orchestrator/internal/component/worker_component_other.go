//go:build !windows

package component

import (
	"context"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func launchComponent(_ context.Context, cfg config.ComponentConfig, _ string, logs *RingBuffer, logger *zap.Logger) (*ManagedProcess, error) {
	return StartProcess(cfg.ExePath, cfg.Args, cfg.WorkingDir, cfg.Env, logs, logger)
}
func preflightComponent(ctx context.Context, cfg config.ComponentConfig, _ string) error {
	return preflight(ctx, cfg)
}

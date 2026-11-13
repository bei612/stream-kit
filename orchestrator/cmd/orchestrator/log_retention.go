package main

import (
	"context"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

// Runs with the service's joined background lifecycle; configuration is the
// immutable running configuration, just like file-log retention.
func runOperationLogRetention(ctx context.Context, st *store.Store, cfg config.OpLogConfig, logger *zap.Logger) {
	if cfg.MaxAgeDays <= 0 && cfg.MaxCount <= 0 {
		return
	}
	timer := time.NewTicker(time.Hour)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		cleanup, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, err := st.CleanupLogs(cleanup, cfg.MaxAgeDays, cfg.MaxCount)
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Warn("Operation log retention failed", zap.Error(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

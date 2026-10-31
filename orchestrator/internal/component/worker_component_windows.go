//go:build windows

package component

import (
	"context"
	"fmt"
	"time"

	"github.com/stream-kit/orchestrator/internal/commandline"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func launchComponent(ctx context.Context, cfg config.ComponentConfig, root string, logs *RingBuffer, logger *zap.Logger) (*ManagedProcess, error) {
	if cfg.WindowsUserSID != "" {
		return startSessionWorker(ctx, cfg, root, cfg.WindowsSessionID, cfg.WindowsUserSID, logs)
	}
	return StartProcess(cfg.ExePath, cfg.Args, cfg.WorkingDir, cfg.Env, logs, logger)
}

func preflightComponent(parent context.Context, cfg config.ComponentConfig, root string) error {
	if cfg.WindowsUserSID == "" {
		return preflight(parent, cfg)
	}
	if _, err := commandline.Parse(cfg.Args); err != nil {
		return err
	}
	if _, err := commandline.Parse(cfg.PreflightArgs); err != nil {
		return err
	}
	if cfg.PreflightArgs == "" {
		return parent.Err()
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	probe := cfg
	probe.Args = cfg.PreflightArgs
	probe.PreflightArgs = ""
	process, err := startSessionWorker(ctx, probe, root, cfg.WindowsSessionID, cfg.WindowsUserSID, NewRingBuffer(2000))
	if err != nil {
		return fmt.Errorf("用户会话原生配置预检启动失败: %w", err)
	}
	go process.RunWait()
	select {
	case <-process.Done:
		if process.ExitCode != 0 {
			return fmt.Errorf("用户会话原生配置预检失败，请检查配置及运行环境")
		}
		return nil
	case <-ctx.Done():
		if err := forceStop(process); err != nil {
			return err
		}
		return fmt.Errorf("用户会话原生配置预检超时或已取消")
	}
}

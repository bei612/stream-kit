package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/sunshine"
)

var ErrCaptureModeUnavailable = errors.New("采集模式不可用")

func (m *Manager) CaptureCapabilities(ctx context.Context) (sunshine.Capabilities, error) {
	if m.sunClient == nil {
		return sunshine.Capabilities{}, fmt.Errorf("编码器未配置，无法读取采集能力")
	}
	return m.sunClient.Capabilities(ctx)
}

func (m *Manager) validateCaptureMode(mode model.CaptureMode) error {
	mode = mode.Normalized()
	if !mode.Valid() {
		return fmt.Errorf("%w：必须为 desktop 或 application", ErrCaptureModeUnavailable)
	}
	if mode == model.CaptureDesktop {
		return nil
	}
	if m.sunClient == nil {
		return fmt.Errorf("%w：编码器未配置，不能启用指定程序采集", ErrCaptureModeUnavailable)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.sunClient.RequireCaptureMode(ctx, mode); err != nil {
		return fmt.Errorf("%w：%s", ErrCaptureModeUnavailable, err)
	}
	return nil
}

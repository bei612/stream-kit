package sunshine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/stream-kit/orchestrator/internal/model"
)

// Capabilities reports the encoder's actual capture contract, not the OS of the
// management process. Version zero represents a legacy desktop-only encoder.
type Capabilities struct {
	SchemaVersion    int                 `json:"schema_version"`
	CaptureModes     []model.CaptureMode `json:"capture_modes"`
	CaptureModeApply string              `json:"capture_mode_apply"`
}

func (c *Client) Capabilities(ctx context.Context) (Capabilities, error) {
	var result Capabilities
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+"/api/stream-kit/capabilities", nil)
	if err != nil {
		return result, err
	}
	c.setBasicAuth(req)
	resp, err := c.client.Do(req)
	if err != nil {
		return result, fmt.Errorf("无法读取编码器采集能力: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Capabilities{CaptureModes: []model.CaptureMode{model.CaptureDesktop}, CaptureModeApply: "application_restart"}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return result, fmt.Errorf("编码器能力查询失败（HTTP %d）", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16385))
	if err != nil || len(body) > 16384 {
		return Capabilities{}, fmt.Errorf("编码器能力响应超过限制或无法读取")
	}
	if err = json.Unmarshal(body, &result); err != nil {
		return Capabilities{}, fmt.Errorf("编码器能力响应无效: %w", err)
	}
	if result.SchemaVersion != 1 || result.CaptureModeApply != "application_restart" || len(result.CaptureModes) < 1 || len(result.CaptureModes) > 2 {
		return Capabilities{}, fmt.Errorf("编码器采集协议版本不兼容")
	}
	seen := map[model.CaptureMode]bool{}
	for _, mode := range result.CaptureModes {
		if !mode.Valid() || seen[mode] {
			return Capabilities{}, fmt.Errorf("编码器采集模式无效")
		}
		seen[mode] = true
	}
	if !seen[model.CaptureDesktop] {
		return Capabilities{}, fmt.Errorf("编码器缺少基础采集模式")
	}
	return result, nil
}

func (c *Client) RequireCaptureMode(ctx context.Context, mode model.CaptureMode) error {
	mode = mode.Normalized()
	if !mode.Valid() {
		return fmt.Errorf("采集模式必须为 desktop 或 application")
	}
	if mode == model.CaptureDesktop {
		return nil
	}
	capabilities, err := c.Capabilities(ctx)
	if err != nil {
		return err
	}
	for _, available := range capabilities.CaptureModes {
		if available == mode {
			return nil
		}
	}
	return fmt.Errorf("当前编码器不支持指定程序画面和声音采集，请先部署支持此功能的服务端版本")
}

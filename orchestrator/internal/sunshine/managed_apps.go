package sunshine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/google/uuid"
)

// ManagedApp identifies one persistent registration independently of its name,
// icon, catalog order or currently running instance.
type ManagedApp struct {
	SchemaVersion int         `json:"schema_version"`
	AppID         string      `json:"app_id"`
	GameStreamID  int         `json:"gamestream_id"`
	App           SunshineApp `json:"app"`
}

func validateManagedID(id string) error {
	parsed, err := uuid.Parse(id)
	if err != nil || parsed == uuid.Nil || parsed.String() != id {
		return fmt.Errorf("应用 ID 必须为规范的非空 UUID")
	}
	return nil
}

// managedRequest never falls back to a name or index mutation on old encoders.
func (c *Client) managedRequest(ctx context.Context, method, id string, app *SunshineApp) (ManagedApp, error) {
	var result ManagedApp
	if err := validateManagedID(id); err != nil {
		return result, err
	}
	capabilities, err := c.Capabilities(ctx)
	if err != nil {
		return result, err
	}
	if capabilities.ManagedAppsVersion != 1 {
		return result, fmt.Errorf("编码器不支持按应用 ID 管理，请部署本项目编译的服务端版本")
	}
	var payload []byte
	if app != nil {
		if err := c.RequireCaptureMode(ctx, app.CaptureMode); err != nil {
			return result, err
		}
		payload, err = json.Marshal(app)
		if err != nil {
			return result, err
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+"/api/stream-kit/apps/"+id, bytes.NewReader(payload))
		if err != nil {
			return result, err
		}
		c.setBasicAuth(req)
		if method != http.MethodGet {
			token, err := c.GetCSRFToken(ctx)
			if err != nil {
				return result, err
			}
			req.Header.Set("X-CSRF-Token", token)
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.client.Do(req)
		if err != nil {
			return result, fmt.Errorf("应用注册事务请求失败: %w", err)
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 262145))
		resp.Body.Close()
		if resp.StatusCode == http.StatusForbidden && attempt == 0 {
			c.invalidateCSRF()
			continue
		}
		if readErr != nil || len(body) > 262144 {
			return result, fmt.Errorf("应用注册事务响应不可读或超过限制")
		}
		if resp.StatusCode != http.StatusOK {
			return result, fmt.Errorf("应用注册事务失败（HTTP %d）", resp.StatusCode)
		}
		if err := json.Unmarshal(body, &result); err != nil {
			return ManagedApp{}, fmt.Errorf("应用注册事务响应无效: %w", err)
		}
		if result.SchemaVersion != 1 || result.AppID != id || result.GameStreamID < 1 || result.GameStreamID > 2147483647 {
			return ManagedApp{}, fmt.Errorf("应用注册事务身份或协议版本不匹配")
		}
		if method != http.MethodDelete && result.App.ManagedID != id {
			return ManagedApp{}, fmt.Errorf("编码器返回的应用归属不匹配")
		}
		return result, nil
	}
	return result, fmt.Errorf("应用注册事务认证失败")
}

func (c *Client) UpsertManagedApp(ctx context.Context, id string, app SunshineApp) (ManagedApp, error) {
	if app.ManagedID != "" && app.ManagedID != id {
		return ManagedApp{}, fmt.Errorf("应用配置归属与请求 ID 不匹配")
	}
	app.ManagedID = id
	return c.managedRequest(ctx, http.MethodPut, id, &app)
}

func (c *Client) GetManagedApp(ctx context.Context, id string) (ManagedApp, error) {
	return c.managedRequest(ctx, http.MethodGet, id, nil)
}

func (c *Client) DeleteManagedApp(ctx context.Context, id string) error {
	_, err := c.managedRequest(ctx, http.MethodDelete, id, nil)
	return err
}

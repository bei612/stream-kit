package moonlight

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

type Host struct {
	HostID uint32 `json:"host_id"`
	Name   string `json:"name"`
	Paired string `json:"paired"`
}

type App struct {
	AppID uint32 `json:"app_id"`
	Title string `json:"title"`
}

type Client struct {
	cfg    config.MoonlightWebConfig
	client *http.Client
	logger *zap.Logger

	mu           sync.Mutex
	sessionToken string
	tokenExpiry  time.Time
}

func NewClient(cfg config.MoonlightWebConfig, logger *zap.Logger) *Client {
	return &Client{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
		logger: logger,
	}
}

// login authenticates with Moonlight-Web and caches the session token.
func (c *Client) login(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Return cached token if still valid (1 hour buffer before 24h expiry)
	if c.sessionToken != "" && time.Now().Before(c.tokenExpiry) {
		return c.sessionToken, nil
	}

	body, _ := json.Marshal(map[string]string{
		"name":     c.cfg.Username,
		"password": c.cfg.Password,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/api/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("串流网关登录失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("串流网关登录失败: HTTP %d", resp.StatusCode)
	}

	// Extract session token from Set-Cookie: mlSession=<token>
	for _, cookie := range resp.Cookies() {
		if cookie.Name == "mlSession" {
			c.sessionToken = cookie.Value
			c.tokenExpiry = time.Now().Add(23 * time.Hour) // cache for 23h (cookie is 24h)
			return c.sessionToken, nil
		}
	}

	return "", fmt.Errorf("串流网关登录成功但未返回 session cookie")
}

// doRequest executes an authenticated request to Moonlight-Web.
func (c *Client) doRequest(ctx context.Context, method, path string) (*http.Response, error) {
	token, err := c.login(ctx)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("串流网关不可达: %w", err)
	}

	// If 401, invalidate cached token and retry once
	if resp.StatusCode == 401 {
		resp.Body.Close()
		c.mu.Lock()
		c.sessionToken = ""
		c.mu.Unlock()

		token, err = c.login(ctx)
		if err != nil {
			return nil, err
		}
		req, _ = http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		return c.client.Do(req)
	}

	return resp, nil
}

func (c *Client) GetHosts(ctx context.Context) ([]Host, error) {
	if c.cfg.BaseURL == "" {
		return nil, fmt.Errorf("moonlight_web.base_url 未配置")
	}

	resp, err := c.doRequest(ctx, http.MethodGet, "/api/hosts")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Moonlight-Web returns streaming JSON (multiple lines). Read first line only.
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("读取串流主机列表失败: HTTP %d", resp.StatusCode)
	}
	var result struct {
		Hosts []Host `json:"hosts"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("解析主机列表失败: %w", err)
	}
	return result.Hosts, nil
}

func (c *Client) GetApps(ctx context.Context, hostID uint32) ([]App, error) {
	if c.cfg.BaseURL == "" {
		return nil, fmt.Errorf("moonlight_web.base_url 未配置")
	}

	path := fmt.Sprintf("/api/apps?host_id=%d", hostID)
	resp, err := c.doRequest(ctx, http.MethodGet, path)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Apps []App `json:"apps"`
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("读取串流应用列表失败: HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return nil, fmt.Errorf("解析应用列表失败: %w", err)
	}
	return result.Apps, nil
}

// StreamURLInfo holds the parts needed to construct a stream URL on the frontend.
type StreamURLInfo struct {
	Port   string `json:"port"`
	Path   string `json:"path"`
	HostID uint32 `json:"host_id"`
	AppID  uint32 `json:"app_id"`
}

// BuildStreamInfo returns structured data for the frontend to construct the stream URL
// using the user's current hostname (so it works for both localhost and remote access).
func (c *Client) BuildStreamInfo(hostID, appID uint32) StreamURLInfo {
	port := "8080"
	if idx := strings.LastIndex(c.cfg.BaseURL, ":"); idx > 5 {
		p := strings.TrimRight(c.cfg.BaseURL[idx+1:], "/")
		if p != "" {
			port = p
		}
	}
	return StreamURLInfo{
		Port:   port,
		Path:   fmt.Sprintf("/stream.html?hostId=%d&appId=%d", hostID, appID),
		HostID: hostID,
		AppID:  appID,
	}
}

// FindStreamInfo finds the stream info for an app by name.
// Legacy callers only. Managed applications use FindStreamInfoByID.
func (c *Client) FindStreamInfo(ctx context.Context, appName string) (*StreamURLInfo, error) {
	hosts, err := c.GetHosts(ctx)
	if err != nil {
		return nil, err
	}

	for _, host := range hosts {
		apps, err := c.GetApps(ctx, host.HostID)
		if err != nil {
			continue
		}
		for _, app := range apps {
			if app.Title == appName {
				info := c.BuildStreamInfo(host.HostID, app.AppID)
				return &info, nil
			}
		}
	}

	return nil, fmt.Errorf("串流网关中未找到应用: %s", appName)
}

// FindStreamInfoByID resolves the immutable native ID and refuses ambiguous hosts.
func (c *Client) FindStreamInfoByID(ctx context.Context, appID uint32) (*StreamURLInfo, error) {
	if appID == 0 || appID > 2147483647 {
		return nil, fmt.Errorf("无效的编码器应用 ID")
	}
	hosts, err := c.GetHosts(ctx)
	if err != nil {
		return nil, err
	}
	var found *StreamURLInfo
	for _, host := range hosts {
		apps, err := c.GetApps(ctx, host.HostID)
		if err != nil {
			return nil, fmt.Errorf("无法确认串流主机应用目录: %w", err)
		}
		for _, app := range apps {
			if app.AppID != appID {
				continue
			}
			if found != nil {
				return nil, fmt.Errorf("多个串流主机报告相同应用 ID，无法确定目标")
			}
			info := c.BuildStreamInfo(host.HostID, app.AppID)
			found = &info
		}
	}
	if found == nil {
		return nil, fmt.Errorf("串流网关未发现应用 ID %d", appID)
	}
	return found, nil
}

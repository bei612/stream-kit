package sunshine

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

type SunshineApp struct {
	Name        string `json:"name"`
	Cmd         string `json:"cmd,omitempty"`
	WorkingDir  string `json:"working-dir,omitempty"`
	Output      string `json:"output,omitempty"`
	AutoDetach  bool   `json:"auto-detach"`
	WaitAll     bool   `json:"wait-all"`
	ExitTimeout int    `json:"exit-timeout"`
	Elevated    bool   `json:"elevated"`
	ImagePath   string `json:"image-path,omitempty"`
}

type Client struct {
	cfg       config.SunshineAPIConfig
	client    *http.Client
	logger    *zap.Logger
	csrfToken string
	csrfTime  time.Time
	csrfMu    sync.Mutex
}

func NewClient(cfg config.SunshineAPIConfig, logger *zap.Logger) *Client {
	transport := &http.Transport{}
	if !cfg.VerifySSL {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &Client{
		cfg:    cfg,
		logger: logger,
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: transport,
		},
	}
}

func (c *Client) HealthCheck(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+"/api/configLocale", nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("Sunshine 不可达: %w", err)
	}
	resp.Body.Close()
	return nil
}

func (c *Client) GetCSRFToken(ctx context.Context) (string, error) {
	c.csrfMu.Lock()
	defer c.csrfMu.Unlock()

	// Cache for 50 minutes (token valid 1 hour)
	if c.csrfToken != "" && time.Since(c.csrfTime) < 50*time.Minute {
		return c.csrfToken, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+"/api/csrf-token", nil)
	if err != nil {
		return "", err
	}
	c.setBasicAuth(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("获取 CSRF token 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return "", fmt.Errorf("Sunshine 认证失败，请检查用户名密码")
	}

	var result struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("解析 CSRF 响应失败: %w", err)
	}

	c.csrfToken = result.CSRFToken
	c.csrfTime = time.Now()
	return c.csrfToken, nil
}

func (c *Client) ListApps(ctx context.Context) ([]SunshineApp, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+"/api/apps", nil)
	if err != nil {
		return nil, err
	}
	c.setBasicAuth(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("查询 Sunshine 应用列表失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("Sunshine 认证失败")
	}

	var result struct {
		Apps []SunshineApp `json:"apps"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &result); err != nil {
		// Try as array directly
		var apps []SunshineApp
		if err2 := json.Unmarshal(body, &apps); err2 != nil {
			return nil, fmt.Errorf("解析应用列表失败: %w", err)
		}
		return apps, nil
	}
	return result.Apps, nil
}

func (c *Client) CreateApp(ctx context.Context, app SunshineApp) error {
	return c.doAppWrite(ctx, http.MethodPost, app, -1)
}

func (c *Client) DeleteApp(ctx context.Context, index int) error {
	token, err := c.GetCSRFToken(ctx)
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/api/apps/%d", c.cfg.BaseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	c.setBasicAuth(req)
	req.Header.Set("X-CSRF-Token", token)

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("删除 Sunshine 应用失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 403 {
		// CSRF expired, retry once
		c.invalidateCSRF()
		return c.deleteAppRetry(ctx, index)
	}

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Sunshine 返回错误 %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func (c *Client) CloseApp(ctx context.Context) error {
	token, err := c.GetCSRFToken(ctx)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/api/apps/close", nil)
	if err != nil {
		return err
	}
	c.setBasicAuth(req)
	req.Header.Set("X-CSRF-Token", token)

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("关闭 Sunshine 应用失败: %w", err)
	}
	resp.Body.Close()
	return nil
}

// ServerInfo holds the streaming state from Sunshine /serverinfo.
type ServerInfo struct {
	CurrentGame int    // 0 = idle, >0 = app index currently running
	State       string // e.g. "SUNSHINE_SERVER_FREE", "SUNSHINE_SERVER_BUSY"
}

// serverInfoURL keeps the public GameStream endpoint separate from the management API.
func (c *Client) serverInfoURL() (string, error) {
	if c.cfg.ServerInfoURL != "" {
		return c.cfg.ServerInfoURL, nil
	}
	u, err := url.Parse(c.cfg.BaseURL)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("请配置 sunshine_api.server_info_url")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 2 || port > 65535 || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("无法从管理地址推导 GameStream 端口，请配置 sunshine_api.server_info_url")
	}
	// Sunshine's management HTTPS port is base+1; GameStream HTTP is base.
	return "http://" + net.JoinHostPort(u.Hostname(), strconv.Itoa(port-1)) + "/serverinfo", nil
}

func (c *Client) GetServerInfo(ctx context.Context) (*ServerInfo, error) {
	endpoint, err := c.serverInfoURL()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("查询编码器状态失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("查询编码器状态失败: HTTP %d", resp.StatusCode)
	}
	var result struct {
		XMLName     xml.Name `xml:"root"`
		StatusCode  string   `xml:"status_code,attr"`
		CurrentGame *int     `xml:"currentgame"`
		State       string   `xml:"state"`
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return nil, fmt.Errorf("解析编码器状态失败: %w", err)
	}
	if result.CurrentGame == nil || (result.StatusCode != "" && result.StatusCode != "200") {
		return nil, fmt.Errorf("编码器状态响应缺少 currentgame 或返回错误状态")
	}
	return &ServerInfo{CurrentGame: *result.CurrentGame, State: result.State}, nil
}

// FindAppIndex finds an app by name and returns its index.
func (c *Client) FindAppIndex(ctx context.Context, name string) (int, error) {
	apps, err := c.ListApps(ctx)
	if err != nil {
		return -1, err
	}
	for i, a := range apps {
		if a.Name == name {
			return i, nil
		}
	}
	return -1, fmt.Errorf("Sunshine 中未找到应用: %s", name)
}

// Internal helpers

func (c *Client) doAppWrite(ctx context.Context, method string, app SunshineApp, index int) error {
	token, err := c.GetCSRFToken(ctx)
	if err != nil {
		return err
	}

	payload := map[string]interface{}{
		"index":        index,
		"name":         app.Name,
		"cmd":          app.Cmd,
		"working-dir":  app.WorkingDir,
		"output":       app.Output,
		"image-path":   app.ImagePath,
		"auto-detach":  app.AutoDetach,
		"wait-all":     app.WaitAll,
		"exit-timeout": app.ExitTimeout,
		"elevated":     app.Elevated,
		"prep-cmd":     []interface{}{},
		"detached":     []interface{}{},
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+"/api/apps", bytes.NewReader(body))
	if err != nil {
		return err
	}
	c.setBasicAuth(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", token)

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("Sunshine API 调用失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 403 {
		c.invalidateCSRF()
		// Retry once with fresh token
		return c.doAppWriteRetry(ctx, method, app, index)
	}

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Sunshine 返回错误 %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func (c *Client) doAppWriteRetry(ctx context.Context, method string, app SunshineApp, index int) error {
	token, err := c.GetCSRFToken(ctx)
	if err != nil {
		return err
	}
	payload := map[string]interface{}{
		"index":        index,
		"name":         app.Name,
		"cmd":          app.Cmd,
		"working-dir":  app.WorkingDir,
		"output":       app.Output,
		"image-path":   app.ImagePath,
		"auto-detach":  app.AutoDetach,
		"wait-all":     app.WaitAll,
		"exit-timeout": app.ExitTimeout,
		"elevated":     app.Elevated,
		"prep-cmd":     []interface{}{},
		"detached":     []interface{}{},
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+"/api/apps", bytes.NewReader(body))
	c.setBasicAuth(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", token)
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Sunshine 重试失败 %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func (c *Client) deleteAppRetry(ctx context.Context, index int) error {
	token, err := c.GetCSRFToken(ctx)
	if err != nil {
		return fmt.Errorf("CSRF token 获取失败: %w", err)
	}
	url := fmt.Sprintf("%s/api/apps/%d", c.cfg.BaseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	c.setBasicAuth(req)
	req.Header.Set("X-CSRF-Token", token)
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Sunshine 删除重试失败 %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func (c *Client) setBasicAuth(req *http.Request) {
	if c.cfg.Username != "" {
		req.SetBasicAuth(c.cfg.Username, c.cfg.Password)
	}
}

func (c *Client) invalidateCSRF() {
	c.csrfMu.Lock()
	c.csrfToken = ""
	c.csrfMu.Unlock()
}

package moonlight

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type rendererHost struct {
	Host
	Address     string  `json:"address"`
	HTTPPort    uint16  `json:"http_port"`
	UniqueID    string  `json:"unique_id"`
	ServerState *string `json:"server_state"`
}

func sameEndpoint(host rendererHost, address string, port uint16) bool {
	return strings.EqualFold(strings.Trim(host.Address, "[]"), strings.Trim(address, "[]")) && host.HTTPPort == port
}

func (c *Client) rendererHost(ctx context.Context, method, path string, body []byte) (rendererHost, error) {
	var result struct {
		Host rendererHost `json:"host"`
	}
	resp, err := c.requestJSON(ctx, method, path, body, c.client)
	if err != nil {
		return result.Host, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return result.Host, fmt.Errorf("读取受管渲染端失败（HTTP %d）", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&result); err != nil {
		return result.Host, fmt.Errorf("渲染端响应无效")
	}
	return result.Host, nil
}

// FindManagedStream enrolls only the configured renderer, then resolves the native
// app ID on that host. Concurrent launches share one enrollment; cancellation also
// applies while waiting for the lock. No name-based or arbitrary-host fallback exists.
func (c *Client) FindManagedStream(ctx context.Context, address string, port uint16, appID uint32, approve func(context.Context, string, string) error) (*StreamURLInfo, error) {
	if approve == nil {
		return nil, fmt.Errorf("受管配对审批未配置")
	}
	return c.findRendererStream(ctx, address, port, appID, approve)
}

// FindRendererStream performs the same scoped lookup without creating or pairing
// a host. Stop/admission must not create new trust relationships as a side effect.
func (c *Client) FindRendererStream(ctx context.Context, address string, port uint16, appID uint32) (*StreamURLInfo, error) {
	return c.findRendererStream(ctx, address, port, appID, nil)
}

func (c *Client) findRendererStream(ctx context.Context, address string, port uint16, appID uint32, approve func(context.Context, string, string) error) (*StreamURLInfo, error) {
	if address == "" || port == 0 || appID == 0 || appID > 2147483647 {
		return nil, fmt.Errorf("受管渲染端配置无效")
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	select {
	case c.enrollment <- struct{}{}:
		defer func() { <-c.enrollment }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	hosts, err := c.GetHosts(ctx)
	if err != nil {
		return nil, err
	}
	var target *rendererHost
	for _, host := range hosts {
		detail, err := c.rendererHost(ctx, http.MethodGet, fmt.Sprintf("/api/host?host_id=%d", host.HostID), nil)
		if err != nil {
			return nil, err
		}
		if detail.HostID != host.HostID {
			return nil, fmt.Errorf("网关返回的渲染端身份不一致")
		}
		if !sameEndpoint(detail, address, port) {
			continue
		}
		if target != nil {
			return nil, fmt.Errorf("配置的渲染端存在重复注册，请移除重复项")
		}
		target = &detail
	}
	if target == nil {
		if approve == nil {
			return nil, fmt.Errorf("受管渲染端尚未注册")
		}
		body, _ := json.Marshal(map[string]any{"address": address, "http_port": port})
		detail, err := c.rendererHost(ctx, http.MethodPost, "/api/host", body)
		if err != nil {
			return nil, err
		}
		target = &detail
	}
	if !sameEndpoint(*target, address, port) || target.ServerState == nil || target.UniqueID == "" || target.UniqueID == "Offline" {
		return nil, fmt.Errorf("受管渲染端离线或身份不匹配")
	}
	if target.Paired != "Paired" {
		if approve == nil {
			return nil, fmt.Errorf("受管渲染端尚未配对")
		}
		if target.Paired != "NotPaired" {
			return nil, fmt.Errorf("渲染端配对状态无效")
		}
		if err := c.pairRenderer(ctx, *target, approve); err != nil {
			return nil, err
		}
	}
	apps, err := c.GetApps(ctx, target.HostID)
	if err != nil {
		return nil, err
	}
	for _, app := range apps {
		if app.AppID == appID {
			info := c.BuildStreamInfo(target.HostID, appID)
			return &info, nil
		}
	}
	return nil, fmt.Errorf("受管渲染端未发现应用 ID %d", appID)
}

func (c *Client) pairRenderer(ctx context.Context, target rendererHost, approve func(context.Context, string, string) error) error {
	body, _ := json.Marshal(map[string]uint32{"host_id": target.HostID})
	client := *c.client
	client.Timeout = 35 * time.Second
	resp, err := c.requestJSON(ctx, http.MethodPost, "/api/host/pair/managed", body, &client)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("受管配对不可用（HTTP %d），请确认组件版本一致", resp.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	var challenge struct {
		SchemaVersion int    `json:"schema_version"`
		PIN           string `json:"pin"`
		Fingerprint   string `json:"client_certificate_sha256"`
	}
	if err := decoder.Decode(&challenge); err != nil {
		return fmt.Errorf("受管配对挑战无效")
	}
	digest, err := hex.DecodeString(challenge.Fingerprint)
	if err != nil || len(digest) != 32 || challenge.SchemaVersion != 1 || len(challenge.PIN) != 4 || strings.Trim(challenge.PIN, "0123456789") != "" {
		return fmt.Errorf("受管配对挑战无效")
	}
	if err := approve(ctx, challenge.Fingerprint, challenge.PIN); err != nil {
		return err
	}
	var result struct {
		Paired *rendererHost `json:"Paired"`
	}
	if err := decoder.Decode(&result); err != nil || result.Paired == nil {
		return fmt.Errorf("受管渲染端配对未完成")
	}
	host := result.Paired
	if host.HostID != target.HostID || !sameEndpoint(*host, target.Address, target.HTTPPort) || host.UniqueID != target.UniqueID || host.ServerState == nil || host.Paired != "Paired" {
		return fmt.Errorf("配对完成后的渲染端身份不一致")
	}
	return nil
}

package sunshine

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// RendererEndpoint derives the GameStream endpoint from the same configuration
// used for renderer health. IPv6 is bracketed for the gateway's address format.
func (c *Client) RendererEndpoint() (string, uint16, error) {
	endpoint, err := c.serverInfoURL()
	if err != nil {
		return "", 0, err
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() == "" || u.User != nil {
		return "", 0, fmt.Errorf("GameStream HTTP 地址无效")
	}
	port := 80
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
	}
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("GameStream HTTP 端口无效")
	}
	address := u.Hostname()
	if strings.Contains(address, ":") {
		address = "[" + address + "]"
	}
	return address, uint16(port), nil
}

// ApprovePairing accepts only the fresh certificate authenticated by the managed
// gateway. Pending device names, source IPs and arrival order are not identities.
func (c *Client) ApprovePairing(ctx context.Context, fingerprint, pin string) error {
	digest, err := hex.DecodeString(fingerprint)
	if err != nil || len(digest) != 32 || len(pin) != 4 || strings.Trim(pin, "0123456789") != "" {
		return fmt.Errorf("配对挑战无效")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pending struct {
			Pairings []struct {
				ID          string `json:"id"`
				Fingerprint string `json:"client_certificate_sha256"`
			} `json:"pairings"`
		}
		if err := c.requestManagedJSON(ctx, http.MethodGet, "/api/pin", nil, 262144, &pending); err != nil {
			return err
		}
		id := ""
		for _, p := range pending.Pairings {
			if !strings.EqualFold(p.Fingerprint, fingerprint) {
				continue
			}
			if id != "" || p.ID == "" {
				return fmt.Errorf("配对证书对应的请求不唯一")
			}
			id = p.ID
		}
		if id != "" {
			payload, _ := json.Marshal(map[string]string{"pairing_id": id, "pin": pin, "name": "Stream Kit managed gateway"})
			var result struct {
				Status bool `json:"status"`
			}
			if err := c.requestManagedJSON(ctx, http.MethodPost, "/api/pin", payload, 16384, &result); err != nil {
				return err
			}
			if !result.Status {
				return fmt.Errorf("渲染端拒绝配对请求")
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("等待受管配对请求超时或已取消: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

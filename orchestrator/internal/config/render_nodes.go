package config

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
)

func removeRenderNode(raw []byte, id string) ([]byte, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	var nodes map[string]json.RawMessage
	if err := json.Unmarshal(object["render_nodes"], &nodes); err != nil {
		return nil, err
	}
	if _, exists := nodes[id]; !exists {
		return nil, fmt.Errorf("render node does not exist")
	}
	delete(nodes, id)
	value, err := json.Marshal(nodes)
	if err != nil {
		return nil, err
	}
	object["render_nodes"] = value
	return json.Marshal(object)
}

// RenderNodeConfig is trusted deployment configuration. Its credentials are
// never included in client tickets or node inventory responses.
type RenderNodeConfig struct {
	Name          string `json:"name" mapstructure:"name"`
	BaseURL       string `json:"base_url" mapstructure:"base_url"`
	ControlSecret string `json:"control_secret" mapstructure:"control_secret"`
}

func validateRenderNodes(cfg *Config) []string {
	var errs []string
	if len(cfg.RenderNodes) > 64 {
		errs = append(errs, "render_nodes 最多允许 64 个节点")
	}
	addresses, secrets := map[string]bool{}, map[string]bool{}
	if cfg.Server.MediaTicketSecret != "" {
		secrets[cfg.Server.MediaTicketSecret] = true
	}
	if cfg.MoonlightWeb.BaseURL != "" {
		addresses[strings.TrimRight(cfg.MoonlightWeb.BaseURL, "/")] = true
	}
	for id, node := range cfg.RenderNodes {
		validID := len(id) > 0 && len(id) <= 128 && id != "primary"
		for _, c := range id {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
				validID = false
			}
		}
		if !validID {
			errs = append(errs, "render_nodes 节点 ID 必须为 1–128 位字母、数字、横线或下划线，且不能为 primary")
		}
		prefix := fmt.Sprintf("render_nodes.%s", id)
		if strings.TrimSpace(node.Name) == "" || node.Name != strings.TrimSpace(node.Name) || len(node.Name) > 128 || strings.ContainsAny(node.Name, "\r\n\x00") {
			errs = append(errs, prefix+".name 无效")
		}
		u, err := url.Parse(node.BaseURL)
		validURL := validServiceURL(node.BaseURL) && node.BaseURL == strings.TrimSpace(node.BaseURL)
		if err == nil && validURL && u.Scheme == "http" {
			ip := net.ParseIP(u.Hostname())
			validURL = (ip != nil && ip.IsLoopback()) || strings.EqualFold(u.Hostname(), "localhost")
		}
		if !validURL {
			errs = append(errs, prefix+".base_url 必须使用 HTTPS（仅回环地址允许 HTTP），且不能包含凭据、查询或片段")
		}
		address := strings.TrimRight(node.BaseURL, "/")
		if addresses[address] {
			errs = append(errs, prefix+".base_url 与其他节点重复")
		}
		addresses[address] = true
		if len(node.ControlSecret) < 32 || len(node.ControlSecret) > 4096 || strings.TrimSpace(node.ControlSecret) != node.ControlSecret {
			errs = append(errs, prefix+".control_secret 必须为 32–4096 字节的独立密钥")
		}
		if secrets[node.ControlSecret] {
			errs = append(errs, prefix+".control_secret 不得与其他节点或主网关共用")
		}
		secrets[node.ControlSecret] = true
	}
	return errs
}

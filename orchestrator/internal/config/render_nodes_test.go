package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderNodeValidationAndSecretIsolation(t *testing.T) {
	valid := RenderNodeConfig{"渲染节点", "https://renderer.example/gateway", strings.Repeat("n", 32)}
	for _, tc := range []struct {
		name   string
		mutate func(*Config)
	}{
		{"remote HTTP", func(c *Config) {
			n := c.RenderNodes["node-a"]
			n.BaseURL = "http://192.0.2.1"
			c.RenderNodes["node-a"] = n
		}},
		{"URL credentials", func(c *Config) {
			n := c.RenderNodes["node-a"]
			n.BaseURL = "https://user:secret@renderer.example"
			c.RenderNodes["node-a"] = n
		}},
		{"short secret", func(c *Config) { n := c.RenderNodes["node-a"]; n.ControlSecret = "weak"; c.RenderNodes["node-a"] = n }},
		{"shared key", func(c *Config) { c.Server.MediaTicketSecret = valid.ControlSecret }},
		{"duplicate node", func(c *Config) { c.RenderNodes["node-b"] = valid }},
		{"reserved ID", func(c *Config) { delete(c.RenderNodes, "node-a"); c.RenderNodes["primary"] = valid }},
		{"invalid ID", func(c *Config) { delete(c.RenderNodes, "node-a"); c.RenderNodes["node/a"] = valid }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{RenderNodes: map[string]RenderNodeConfig{"node-a": valid}}
			tc.mutate(c)
			if len(validateRenderNodes(c)) == 0 {
				t.Fatal("invalid node accepted")
			}
		})
	}
	for _, address := range []string{valid.BaseURL, "http://127.0.0.1:9001/prefix", "http://[::1]:9001"} {
		n := valid
		n.BaseURL = address
		c := &Config{RenderNodes: map[string]RenderNodeConfig{"node-a": n}}
		if errs := validateRenderNodes(c); len(errs) != 0 {
			t.Fatal(errs)
		}
		b, _ := json.Marshal(c.Sanitized())
		if strings.Contains(string(b), valid.ControlSecret) {
			t.Fatal("node secret leaked")
		}
	}
}

func TestNodeSettingsAddEditAndCASPreserveSecret(t *testing.T) {
	s, _ := settingsFixture(t)
	v, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	n := RenderNodeConfig{"Renderer", "https://node.example", strings.Repeat("s", 32)}
	raw, _ := json.Marshal(n)
	added, err := s.Save(v.Revision, map[string]json.RawMessage{"/render_nodes/node-a": raw})
	if err != nil {
		t.Fatal(err)
	}
	if !added.RestartRequired {
		t.Fatal("node changes must require restart")
	}
	encoded, _ := json.Marshal(added)
	if strings.Contains(string(encoded), n.ControlSecret) {
		t.Fatal("saved view leaked key")
	}
	if _, err = s.Save(v.Revision, map[string]json.RawMessage{"/render_nodes/node-a/name": json.RawMessage(`"stale"`)}); err == nil {
		t.Fatal("stale editor accepted")
	}
	if _, err = s.Save(added.Revision, map[string]json.RawMessage{"/render_nodes/node-a/name": json.RawMessage(`"Updated"`)}); err != nil {
		t.Fatal(err)
	}
	_, saved, err := s.read()
	if err != nil {
		t.Fatal(err)
	}
	if saved.RenderNodes["node-a"].ControlSecret != n.ControlSecret || saved.RenderNodes["node-a"].Name != "Updated" {
		t.Fatal("node edit lost fields")
	}
	current, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Save(current.Revision, map[string]json.RawMessage{"/render_nodes/node-a": json.RawMessage(`null`)}); err != nil {
		t.Fatal(err)
	}
	_, saved, err = s.read()
	if err != nil || len(saved.RenderNodes) != 0 {
		t.Fatal("node removal failed", err)
	}
}

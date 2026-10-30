package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFirstRunWithoutTemplateProducesLoadableEditableConfiguration(t *testing.T) {
	previous := BaseDir
	defer func() { BaseDir = previous }()
	var passwords []string
	for i := 0; i < 2; i++ {
		path := filepath.Join(t.TempDir(), "nested", "config.json")
		if cfg, err := Load(path); cfg != nil || err == nil || !strings.Contains(err.Error(), "首次运行") {
			t.Fatal("first run must request review before starting", err)
		}
		cfg, err := Load(path)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Server.BindAddress != "127.0.0.1:9000" || len(cfg.Server.Password) < 20 || len(cfg.Server.JWTSecret) < 32 {
			t.Fatal("unsafe bootstrap defaults")
		}
		passwords = append(passwords, cfg.Server.Password)
		if !filepath.IsAbs(cfg.Storage.DBPath) || len(cfg.Components) != 0 {
			t.Fatal("bootstrap should resolve storage without starting unconfigured components")
		}
		view, err := NewSettings(cfg).View()
		if err != nil || view.RestartRequired {
			t.Fatal("generated configuration not editable", err)
		}
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := generateDefaultConfig(path); !os.IsExist(err) {
			t.Fatal("existing configuration was not protected", err)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("existing configuration was overwritten")
		}
	}
	if passwords[0] == passwords[1] {
		t.Fatal("bootstrap reused administrator credential")
	}
}

func TestBootstrapTemplateValidationAndPreservation(t *testing.T) {
	data, err := os.ReadFile("../../config.example.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []bool{false, true} {
		dir := t.TempDir()
		template := data
		if invalid {
			template = []byte(`{"server":{"log_level":"unsupported"}}`)
		}
		if err := os.WriteFile(filepath.Join(dir, "config.example.json"), template, 0600); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "config.json")
		err := generateDefaultConfig(path)
		if invalid {
			if err == nil {
				t.Fatal("invalid template accepted")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("invalid template created config")
			}
		} else {
			if err != nil {
				t.Fatal(err)
			}
			actual, _ := os.ReadFile(path)
			if !bytes.Equal(actual, template) {
				t.Fatal("explicit template was changed")
			}
		}
	}
}

func TestTLSPathsUseConfigurationDirectory(t *testing.T) {
	previous := BaseDir
	defer func() { BaseDir = previous }()
	s, _ := settingsFixture(t)
	view, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Save(view.Revision, map[string]json.RawMessage{
		"/server/tls_cert": json.RawMessage(`"certs/server.pem"`),
		"/server/tls_key":  json.RawMessage(`"certs/server-key.pem"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.TLSCert != filepath.Join(filepath.Dir(s.path), "certs", "server.pem") ||
		cfg.Server.TLSKey != filepath.Join(filepath.Dir(s.path), "certs", "server-key.pem") {
		t.Fatal("TLS paths depend on process working directory")
	}
	_, saved, err := s.read()
	if err != nil {
		t.Fatal(err)
	}
	if saved.Server.TLSCert != "certs/server.pem" {
		t.Fatal("loading rewrote portable configuration")
	}
}

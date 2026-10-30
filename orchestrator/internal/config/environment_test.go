package config

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestEnvironmentOverlayIsTypedAndDoesNotRewriteFile(t *testing.T) {
	s, _ := settingsFixture(t)
	oldBase := BaseDir
	defer func() { BaseDir = oldBase }()
	before, _ := os.ReadFile(s.path)
	t.Setenv("ORCH_SERVER_PASSWORD", "deployment-secret")
	t.Setenv("ORCH_STORAGE_MAX_FILE_COUNT", "42")
	t.Setenv("ORCH_COMPONENTS_GATEWAY_AUTO_START", "true")
	t.Setenv("ORCH_COMPONENTS_GATEWAY_ENV_SPECIAL", "deployment-device")
	t.Setenv("ORCH_SERVER_CORS_ORIGINS", `["https://one.test","https://two.test"]`)
	loaded, err := Load(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Server.Password != "deployment-secret" || loaded.Storage.MaxFileCount != 42 || !loaded.Components["gateway"].AutoStart || loaded.Components["gateway"].Env["SPECIAL"] != "deployment-device" {
		t.Fatal("deployment overrides not applied")
	}
	if !reflect.DeepEqual(loaded.Server.CORSOrigins, []string{"https://one.test", "https://two.test"}) {
		t.Fatal("list override not parsed")
	}
	after, _ := os.ReadFile(s.path)
	if string(before) != string(after) {
		t.Fatal("load wrote environment secrets into config")
	}
	view, err := NewSettings(loaded).View()
	if err != nil || view.RestartRequired {
		t.Fatal("environment override falsely requested restart", err)
	}
	encoded, _ := json.Marshal(view)
	if strings.Contains(string(encoded), "deployment-secret") || strings.Contains(string(encoded), "deployment-device") {
		t.Fatal("settings disclosed environment value")
	}
}

func TestEnvironmentRejectsInvalidTypedValueWithoutEchoingIt(t *testing.T) {
	t.Setenv("ORCH_STORAGE_MAX_FILE_COUNT", "private-invalid-value")
	cfg := &Config{}
	err := applyEnvironment(cfg)
	if err == nil || strings.Contains(err.Error(), "private-invalid-value") || !strings.Contains(err.Error(), "ORCH_STORAGE_MAX_FILE_COUNT") {
		t.Fatal("unsafe override diagnostic", err)
	}
}

func TestEnvironmentSupportsOptionalAndCompositeFields(t *testing.T) {
	t.Setenv("ORCH_COMPONENTS", `{"Gateway":{"env":{"UPPER":"value"}}}`)
	t.Setenv("ORCH_COMPONENTS_GATEWAY_HEALTH_CHECK_VERIFY_SSL", "false")
	t.Setenv("ORCH_SERVER_CORS_ORIGINS", "https://one.test, https://two.test")
	t.Setenv("ORCH_SERVER_PASSWORD", "")
	cfg := &Config{Server: ServerConfig{Password: "retained"}}
	if err := applyEnvironment(cfg); err != nil {
		t.Fatal(err)
	}
	component := cfg.Components["Gateway"]
	if component.Env["UPPER"] != "value" || component.HealthCheck.VerifySSL == nil || *component.HealthCheck.VerifySSL || cfg.Server.Password != "retained" {
		t.Fatal("composite override changed identity or empty-value policy")
	}
	if !reflect.DeepEqual(cfg.Server.CORSOrigins, []string{"https://one.test", "https://two.test"}) {
		t.Fatal("CSV override not parsed")
	}
}

func TestAmbiguousEnvironmentKeyIsRejected(t *testing.T) {
	t.Setenv("ORCH_TEMPLATES_CUSTOM", "replacement")
	cfg := &Config{Templates: map[string]string{"Custom": "one", "custom": "two"}}
	if err := applyEnvironment(cfg); err == nil {
		t.Fatal("ambiguous case-sensitive keys received same override")
	}
	if cfg.Templates["Custom"] != "one" || cfg.Templates["custom"] != "two" {
		t.Fatal("failed overlay changed original config")
	}
}

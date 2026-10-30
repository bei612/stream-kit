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

func TestSettingsSaveValidatesDeploymentWithoutPersistingSecrets(t *testing.T) {
	s, _ := settingsFixture(t)
	previous := BaseDir
	defer func() { BaseDir = previous }()
	t.Setenv("ORCH_SERVER_PASSWORD", "external-only-password")
	view, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	view, err = s.Save(view.Revision, map[string]json.RawMessage{"/server/password": json.RawMessage(`""`)})
	if err != nil {
		t.Fatal("environment-provided password rejected", err)
	}
	_, err = s.Save(view.Revision, map[string]json.RawMessage{"/storage/max_file_count": json.RawMessage(`25`)})
	if err != nil {
		t.Fatal("unrelated edit rejected", err)
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "external-only-password") {
		t.Fatal("deployment credential persisted")
	}
	file, err := decodeSettings(data)
	if err != nil || file.Server.Password != "" {
		t.Fatal("file password changed", err)
	}
	loaded, err := Load(s.path)
	if err != nil || loaded.Server.Password != "external-only-password" || loaded.Storage.MaxFileCount != 25 {
		t.Fatal("saved settings differ from startup", err)
	}
}

func TestSettingsRejectsInvalidDeploymentWithoutChangingFile(t *testing.T) {
	for _, value := range []string{"private-invalid", "0"} {
		t.Run(value, func(t *testing.T) {
			s, _ := settingsFixture(t)
			before, err := os.ReadFile(s.path)
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("ORCH_STORAGE_MAX_FILE_COUNT", value)
			view, err := s.View()
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.Save(view.Revision, map[string]json.RawMessage{"/storage/max_file_count": json.RawMessage(`25`)})
			if err == nil || strings.Contains(err.Error(), "private-invalid") {
				t.Fatal("invalid deployment accepted or exposed", err)
			}
			after, err := os.ReadFile(s.path)
			if err != nil || string(before) != string(after) {
				t.Fatal("failed validation changed file", err)
			}
		})
	}
}

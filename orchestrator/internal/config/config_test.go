package config

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestManagedServiceURLValidation(t *testing.T) {
	for _, address := range []string{"http://127.0.0.1:8080", "https://gateway.example/stream", "https://[::1]:8443"} {
		if !validServiceURL(address) {
			t.Errorf("valid address rejected: %s", address)
		}
	}
	for _, address := range []string{"", "//gateway.example", "file:///tmp/server", "http://", "https://user:password@gateway.example", "https://gateway.example?token=secret", "https://gateway.example#secret"} {
		if validServiceURL(address) {
			t.Errorf("invalid service address accepted: %s", address)
		}
	}
	cfg := Config{Server: ServerConfig{MediaTicketSecret: "short", JWTSecret: "short"}, MoonlightWeb: MoonlightWebConfig{BaseURL: "https://gateway.example"}}
	errors := strings.Join(validate(&cfg), "\n")
	if !strings.Contains(errors, "media_ticket_secret") || !strings.Contains(errors, "jwt_secret") {
		t.Fatal("managed mode accepted weak keys")
	}
}

func TestSanitizedOmitsOpaqueCredentialsWithoutMutatingConfiguration(t *testing.T) {
	cfg := Config{
		Server:      ServerConfig{Password: "abcd-private", JWTSecret: "efgh-private", MediaTicketSecret: "ijkl-private"},
		SunshineAPI: SunshineAPIConfig{BaseURL: "https://u:service-private@example.test", ServerInfoURL: "https://example.test/info-private"},
		Components: map[string]ComponentConfig{"gateway": {
			ExePath: "gateway.exe", Args: "--credential=argument-private",
			Env:         map[string]string{"CUSTOM_VALUE": "environment-private", "EMPTY": ""},
			HealthCheck: HealthCheckConfig{URL: "https://user:health-private@example.test/path-private?query-private#fragment-private"},
		}},
		Notifications: NotificationsConfig{WebhookURL: "https://example.test/webhook-private"},
		Templates:     map[string]string{"custom": "--key=template-private"},
	}
	before, _ := json.Marshal(cfg)
	safe := cfg.Sanitized()
	encoded, err := json.Marshal(safe)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"abcd", "efgh", "ijkl", "service-private", "info-private", "argument-private", "environment-private", "health-private", "path-private", "query-private", "fragment-private", "webhook-private", "template-private"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("exposed credential %s", secret)
		}
	}
	component := safe["components"].(map[string]interface{})["gateway"].(map[string]interface{})
	if component["exe_path"] != "gateway.exe" || component["health_check"].(map[string]interface{})["url"] != "https://example.test" {
		t.Fatal("lost non-secret component identity")
	}
	if component["env"].(map[string]interface{})["EMPTY"] != "" {
		t.Fatal("empty value incorrectly reported configured")
	}
	after, _ := json.Marshal(cfg)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("sanitization mutated live config")
	}
	for _, input := range []string{"%invalid", "file:///secret", "relative/secret", "https://[invalid"} {
		if sanitizedURL(input) != "****" {
			t.Fatal("invalid URL exposed")
		}
	}
}

func TestSanitizedMasksServiceCredentials(t *testing.T) {
	cfg := Config{
		Server:       ServerConfig{Password: "management-secret", JWTSecret: "jwt-signing-secret"},
		SunshineAPI:  SunshineAPIConfig{Password: "sunshine-secret"},
		MoonlightWeb: MoonlightWebConfig{Password: "moonlight-secret"},
	}
	output, err := json.Marshal(cfg.Sanitized())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{cfg.Server.Password, cfg.Server.JWTSecret, cfg.SunshineAPI.Password, cfg.MoonlightWeb.Password} {
		if strings.Contains(string(output), secret) {
			t.Error("configuration response contains an unmasked credential")
		}
	}
	if cfg.Server.Password != "management-secret" || cfg.MoonlightWeb.Password != "moonlight-secret" {
		t.Error("sanitization mutated live configuration")
	}
}

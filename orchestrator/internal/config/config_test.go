package config

import (
	"encoding/json"
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

package config

import (
	"encoding/json"
	"strings"
	"testing"
)

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

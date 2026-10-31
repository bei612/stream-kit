package config

import (
	"encoding/json"
	"os"
	"testing"
)

func TestWindowsSessionConfiguration(t *testing.T) {
	valid := ComponentConfig{ExePath: "renderer.exe", WindowsSessionID: 1, WindowsUserSID: "S-1-5-21-1-2-3-1001"}
	if err := ValidateWindowsSession("sunshine", valid); err != nil {
		t.Fatal(err)
	}
	if err := ValidateWindowsSession("web_server", valid); err != nil {
		t.Fatal(err)
	}
	if err := ValidateWindowsSession("gateway", ComponentConfig{}); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"other-component", "missing-exe", "zero-session", "invalid-session", "missing-sid", "system", "invalid-authority", "overflow", "negative", "leading-zero"} {
		cfg := valid
		name := "sunshine"
		switch mode {
		case "other-component":
			name = "gateway"
		case "missing-exe":
			cfg.ExePath = ""
		case "zero-session":
			cfg.WindowsSessionID = 0
		case "invalid-session":
			cfg.WindowsSessionID = ^uint32(0)
		case "missing-sid":
			cfg.WindowsUserSID = ""
		case "system":
			cfg.WindowsUserSID = "S-1-5-18"
		case "invalid-authority":
			cfg.WindowsUserSID = "S-1-281474976710656-1"
		case "overflow":
			cfg.WindowsUserSID = "S-1-5-4294967296"
		case "negative":
			cfg.WindowsUserSID = "S-1-5--1"
		case "leading-zero":
			cfg.WindowsUserSID = "S-1-5-01"
		}
		if ValidateWindowsSession(name, cfg) == nil {
			t.Fatalf("accepted %s", mode)
		}
	}
}

func TestSettingsWindowsSessionPairSavedAtomically(t *testing.T) {
	for _, name := range []string{"sunshine", "web_server"} {
		t.Run(name, func(t *testing.T) { testSettingsWindowsSessionPairSavedAtomically(t, name) })
	}
}

func testSettingsWindowsSessionPairSavedAtomically(t *testing.T, name string) {
	s, cfg := settingsFixture(t)
	cfg.Components[name] = ComponentConfig{ExePath: name + ".exe"}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(s.path, data, 0600); err != nil {
		t.Fatal(err)
	}
	view, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(view.Revision, map[string]json.RawMessage{"/components/" + name + "/windows_session_id": json.RawMessage(`1`)}); err == nil {
		t.Fatal("incomplete session saved")
	}
	after, err := s.Save(view.Revision, map[string]json.RawMessage{
		"/components/" + name + "/windows_session_id": json.RawMessage(`1`),
		"/components/" + name + "/windows_user_sid":   json.RawMessage(`"S-1-5-21-1-2-3-1001"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !after.RestartRequired || after.ApplyPolicy != "service_restart" {
		t.Fatal("session changes must require service restart")
	}
	_, persisted, err := s.read()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Components[name].WindowsSessionID != 1 || persisted.Components[name].WindowsUserSID != "S-1-5-21-1-2-3-1001" {
		t.Fatal("session selection lost")
	}
	if cfg.Components[name].WindowsSessionID != 0 {
		t.Fatal("running configuration mutated")
	}
}

package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartupAndSettingsUseSameFileLimit(t *testing.T) {
	previous := BaseDir
	defer func() { BaseDir = previous }()
	s, _ := settingsFixture(t)
	original, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{maxConfigBytes, maxConfigBytes + 1} {
		data := append(bytes.Clone(original), bytes.Repeat([]byte(" "), size-len(original))...)
		if err := os.WriteFile(s.path, data, 0600); err != nil {
			t.Fatal(err)
		}
		_, startupErr := Load(s.path)
		_, viewErr := s.View()
		if size == maxConfigBytes {
			if startupErr != nil || viewErr != nil {
				t.Fatalf("boundary file rejected: startup=%v management=%v", startupErr, viewErr)
			}
		} else if !errors.Is(startupErr, ErrSettingsUnavailable) || !errors.Is(viewErr, ErrSettingsUnavailable) {
			t.Fatalf("oversized file accepted: startup=%v management=%v", startupErr, viewErr)
		}
	}
	if _, err := readConfigSource(t.TempDir()); !errors.Is(err, ErrSettingsUnavailable) {
		t.Fatal("directory accepted", err)
	}
}

func TestSettingsRejectsFormattedOverflowWithoutReplacingFile(t *testing.T) {
	s, cfg := settingsFixture(t)
	before, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Server.Password = ""
	compact, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	password := strings.Repeat("x", maxConfigBytes-len(compact))
	cfg.Server.Password = password
	compact, _ = json.Marshal(cfg)
	formatted, _ := json.MarshalIndent(cfg, "", "  ")
	if len(compact) != maxConfigBytes || len(formatted) <= maxConfigBytes {
		t.Fatal("fixture does not cross the formatting boundary")
	}
	value, _ := json.Marshal(password)
	if _, err := s.Save(revision(before), map[string]json.RawMessage{"/server/password": value}); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatal("formatted overflow accepted", err)
	}
	after, err := os.ReadFile(s.path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed save modified the configuration", err)
	}
	if _, err := s.View(); err != nil {
		t.Fatal("original configuration no longer editable", err)
	}
}

func TestBootstrapRejectsOversizedTemplateWithoutCreatingConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(filepath.Join(dir, "config.example.json"), bytes.Repeat([]byte(" "), maxConfigBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	if err := generateDefaultConfig(path); !errors.Is(err, ErrSettingsUnavailable) {
		t.Fatal("oversized template not rejected at the shared file boundary", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("unreadable first-run configuration created", err)
	}
}

package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func settingsFixture(t *testing.T) (*Settings, *Config) {
	t.Helper()
	cfg := &Config{Server: ServerConfig{BindAddress: "127.0.0.1:9000", Username: "admin", Password: "original-secret"}, Storage: StorageConfig{AppsDir: "apps", TempDir: "temp", DBPath: "state.db", MaxUploadSize: 1024, MaxExtractSize: 2048, MaxFileCount: 10}, Process: ProcessConfig{MonitorInterval: 5}, Components: map[string]ComponentConfig{"gateway": {Args: "--key=private", Env: map[string]string{"SPECIAL": "env-secret"}}}}
	data, _ := json.Marshal(cfg)
	cfg.sourcePath = filepath.Join(t.TempDir(), "config.json")
	cfg.sourceRevision = revision(data)
	if err := os.WriteFile(cfg.sourcePath, data, 0600); err != nil {
		t.Fatal(err)
	}
	return NewSettings(cfg), cfg
}

func TestSettingsReloadPreservesEnvironmentAndTemplateNames(t *testing.T) {
	s, _ := settingsFixture(t)
	before := BaseDir
	defer func() { BaseDir = before }()
	view, _ := s.View()
	_, err := s.Save(view.Revision, map[string]json.RawMessage{"/templates": json.RawMessage(`{"UE5Windowed":"-windowed"}`), "/components/gateway/env/STREAM_KIT_DEVICE": json.RawMessage(`"device-1"`)})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(s.path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Components["gateway"].Env["STREAM_KIT_DEVICE"] != "device-1" || loaded.Components["gateway"].Env["SPECIAL"] != "env-secret" || loaded.Templates["UE5Windowed"] != "-windowed" {
		t.Fatal("reload changed case-sensitive environment or template keys")
	}
}

func TestSettingsSavePreservesSecretsAndRunningConfig(t *testing.T) {
	s, running := settingsFixture(t)
	before, err := s.View()
	if err != nil {
		t.Fatal(err)
	}
	if before.RestartRequired {
		t.Fatal("unchanged config requests restart")
	}
	encoded, _ := json.Marshal(before)
	if strings.Contains(string(encoded), "original-secret") || strings.Contains(string(encoded), "env-secret") {
		t.Fatal("view leaked secrets")
	}
	after, err := s.Save(before.Revision, map[string]json.RawMessage{"/storage/max_file_count": json.RawMessage(`20`)})
	if err != nil || !after.RestartRequired || after.Revision == before.Revision {
		t.Fatalf("save: %+v %v", after, err)
	}
	_, persisted, err := s.read()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Server.Password != "original-secret" || persisted.Components["gateway"].Env["SPECIAL"] != "env-secret" || persisted.Storage.MaxFileCount != 20 {
		t.Fatal("save lost unedited configuration")
	}
	if running.Storage.MaxFileCount != 10 {
		t.Fatal("save mutated runtime")
	}
	if _, err = s.Save(before.Revision, map[string]json.RawMessage{"/storage/max_file_count": json.RawMessage(`30`)}); !errors.Is(err, ErrSettingsConflict) {
		t.Fatal("stale save accepted", err)
	}
	if _, err = s.Save(after.Revision, map[string]json.RawMessage{"/server/password": json.RawMessage(`"replacement-secret"`)}); err != nil {
		t.Fatal(err)
	}
}

func TestSettingsRejectsInvalidChangesWithoutWriting(t *testing.T) {
	for _, changes := range []map[string]json.RawMessage{
		{"/storage/max_file_count": json.RawMessage(`0`)},
		{"/server/unknown": json.RawMessage(`true`)},
		{"/process/monitor_interval_seconds": json.RawMessage(`"bad"`)},
		{"/components/gateway/unknown": json.RawMessage(`1`)},
		{"/components/gateway/args": json.RawMessage(`"\"private-unclosed"`)},
		{"/components/gateway/args": json.RawMessage(`"private\u0000value"`)},
		{"/components/gateway/exe_path": json.RawMessage(`"gateway.exe"`), "/components/gateway/preflight_args": json.RawMessage(`"'private-unclosed"`)},
		{"/server": json.RawMessage(`{}`), "/server/username": json.RawMessage(`"other"`)},
		{"/server/~invalid": json.RawMessage(`"value"`)},
	} {
		s, _ := settingsFixture(t)
		before, _ := os.ReadFile(s.path)
		if _, err := s.Save(revision(before), changes); err == nil {
			t.Fatalf("accepted %v", changes)
		}
		after, _ := os.ReadFile(s.path)
		if string(before) != string(after) {
			t.Fatal("failed update changed file")
		}
	}
}

func TestSettingsConcurrentEditorsHaveOneWinner(t *testing.T) {
	s, _ := settingsFixture(t)
	view, _ := s.View()
	var wg sync.WaitGroup
	outcomes := make(chan error, 2)
	for _, value := range []string{`20`, `30`} {
		wg.Add(1)
		go func(value string) {
			defer wg.Done()
			_, err := s.Save(view.Revision, map[string]json.RawMessage{"/storage/max_file_count": json.RawMessage(value)})
			outcomes <- err
		}(value)
	}
	wg.Wait()
	close(outcomes)
	successes, conflicts := 0, 0
	for err := range outcomes {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrSettingsConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("concurrent writes were not serialized")
	}
}

func TestSettingsExternalEditDetected(t *testing.T) {
	s, _ := settingsFixture(t)
	view, _ := s.View()
	data, _ := os.ReadFile(s.path)
	data = append(data, '\n')
	if err := os.WriteFile(s.path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(view.Revision, map[string]json.RawMessage{"/server/username": json.RawMessage(`"new"`)}); !errors.Is(err, ErrSettingsConflict) {
		t.Fatal("external change overwritten")
	}
}

func TestSettingsAddsEnvironmentValueToNullMap(t *testing.T) {
	s, _ := settingsFixture(t)
	data, cfg, _ := s.read()
	component := cfg.Components["gateway"]
	component.Env = nil
	cfg.Components["gateway"] = component
	data, _ = json.Marshal(cfg)
	if err := os.WriteFile(s.path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(revision(data), map[string]json.RawMessage{"/components/gateway/env/NEW": json.RawMessage(`"private-new"`)}); err != nil {
		t.Fatal(err)
	}
	_, saved, err := s.read()
	if err != nil || saved.Components["gateway"].Env["NEW"] != "private-new" {
		t.Fatal("new environment value not saved", err)
	}
}

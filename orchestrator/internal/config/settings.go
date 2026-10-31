package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
)

var ErrSettingsConflict = errors.New("configuration changed; reload before saving")
var ErrSettingsUnavailable = errors.New("configuration source is unavailable")

// Settings owns file-backed desired configuration. Runtime consumers retain the
// immutable Config loaded at process startup; saving never mutates those objects.
type Settings struct {
	mu                    sync.Mutex
	path, runningRevision string
}

type SettingsView struct {
	Revision             string                 `json:"revision"`
	RestartRequired      bool                   `json:"restart_required"`
	ApplyPolicy          string                 `json:"apply_policy"`
	Values               map[string]interface{} `json:"values"`
	RedactedPaths        []string               `json:"redacted_paths"`
	EnvironmentOverrides []string               `json:"environment_overrides"`
}

func NewSettings(cfg *Config) *Settings {
	return &Settings{path: cfg.sourcePath, runningRevision: cfg.sourceRevision}
}
func revision(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func decodeSettings(data []byte) (*Config, error) {
	var cfg Config
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&cfg); err != nil {
		return nil, errors.New("configuration has unknown fields or invalid value types")
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("configuration must contain exactly one object")
	}
	return &cfg, nil
}

func (s *Settings) read() ([]byte, *Config, error) {
	if s.path == "" {
		return nil, nil, ErrSettingsUnavailable
	}
	data, err := readConfigSource(s.path)
	if err != nil {
		return nil, nil, err
	}
	cfg, err := decodeSettings(data)
	return data, cfg, err
}

func (s *Settings) View() (*SettingsView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, cfg, err := s.read()
	if err != nil {
		return nil, err
	}
	return s.view(data, cfg), nil
}

func (s *Settings) view(data []byte, cfg *Config) *SettingsView {
	v := &SettingsView{Revision: revision(data), ApplyPolicy: "service_restart", Values: cfg.Sanitized(), RedactedPaths: []string{}, EnvironmentOverrides: []string{}}
	v.RestartRequired = v.Revision != s.runningRevision
	// Optional fields must remain editable even when omitted from the file.
	if service, ok := v.Values["sunshine_api"].(map[string]interface{}); ok {
		if _, exists := service["server_info_url"]; !exists {
			service["server_info_url"] = ""
		}
	}
	if components, ok := v.Values["components"].(map[string]interface{}); ok {
		for _, raw := range components {
			if component, ok := raw.(map[string]interface{}); ok {
				if health, ok := component["health_check"].(map[string]interface{}); ok {
					if _, exists := health["verify_ssl"]; !exists {
						health["verify_ssl"] = nil
					}
				}
			}
		}
	}
	raw, _ := json.Marshal(cfg)
	var original map[string]interface{}
	_ = json.Unmarshal(raw, &original)
	var walk func(map[string]interface{}, map[string]interface{}, string)
	walk = func(a, b map[string]interface{}, path string) {
		for key, value := range a {
			p := path + "/" + strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
			if child, ok := value.(map[string]interface{}); ok {
				if safe, ok := b[key].(map[string]interface{}); ok {
					walk(child, safe, p)
				}
				continue
			}
			if !reflect.DeepEqual(value, b[key]) {
				v.RedactedPaths = append(v.RedactedPaths, p)
			}
		}
	}
	walk(original, v.Values, "")
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "ORCH_") {
			v.EnvironmentOverrides = append(v.EnvironmentOverrides, name)
		}
	}
	sort.Strings(v.RedactedPaths)
	sort.Strings(v.EnvironmentOverrides)
	return v
}

// Save changes only explicitly submitted JSON-pointer fields. Hidden values are
// retained by omission, never by interpreting a masking string as a password.
func (s *Settings) Save(expected string, changes map[string]json.RawMessage) (*SettingsView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, current, err := s.read()
	if err != nil {
		return nil, err
	}
	if expected == "" || expected != revision(data) {
		return nil, ErrSettingsConflict
	}
	if len(changes) == 0 || len(changes) > 256 {
		return nil, errors.New("submit between 1 and 256 changed fields")
	}
	// Serialize typed configuration to preserve integer widths while modifying
	// raw JSON subtrees. Unknown keys are rejected by the final typed decode.
	base, _ := json.Marshal(current)
	paths := make([]string, 0, len(changes))
	for p := range changes {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for i, p := range paths {
		for _, previous := range paths[:i] {
			if strings.HasPrefix(p, previous+"/") {
				return nil, errors.New("overlapping configuration changes")
			}
		}
		if !strings.HasPrefix(p, "/") || len(p) > 512 {
			return nil, errors.New("invalid configuration field path")
		}
		segments := strings.Split(p[1:], "/")
		for j, part := range segments {
			if part == "" || strings.Contains(strings.ReplaceAll(strings.ReplaceAll(part, "~0", ""), "~1", ""), "~") {
				return nil, errors.New("invalid configuration field path")
			}
			segments[j] = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		}
		if len(segments) == 2 && segments[0] == "render_nodes" && bytes.Equal(bytes.TrimSpace(changes[p]), []byte("null")) {
			base, err = removeRenderNode(base, segments[1])
		} else {
			base, err = replaceField(base, segments, changes[p])
		}
		if err != nil {
			return nil, err
		}
	}
	if len(base) > maxConfigBytes {
		return nil, errors.New("configuration exceeds size limit")
	}
	next, err := decodeSettings(base)
	if err != nil {
		return nil, err
	}
	if _, err := deploymentConfig(next); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}
	output, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return nil, err
	}
	output = append(output, '\n')
	if len(output) > maxConfigBytes {
		return nil, errors.New("configuration exceeds size limit")
	}
	// Detect edits by another writer since the snapshot before replacing it.
	latest, _, err := s.read()
	if err != nil {
		return nil, err
	}
	if revision(latest) != expected {
		return nil, ErrSettingsConflict
	}
	if err := writeSettings(s.path, output); err != nil {
		return nil, errors.New("configuration could not be saved")
	}
	return s.view(output, next), nil
}

func replaceField(raw json.RawMessage, path []string, value json.RawMessage) (json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return nil, errors.New("configuration path must traverse an object")
	}
	if object == nil {
		object = map[string]json.RawMessage{}
	}
	if len(path) == 1 {
		if !json.Valid(value) {
			return nil, errors.New("invalid configuration value")
		}
		object[path[0]] = value
	} else {
		child, ok := object[path[0]]
		if !ok {
			return nil, errors.New("configuration parent does not exist")
		}
		next, err := replaceField(child, path[1:], value)
		if err != nil {
			return nil, err
		}
		object[path[0]] = next
	}
	return json.Marshal(object)
}

func writeSettings(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".stream-kit-config-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return replaceSettingsFile(name, path)
}

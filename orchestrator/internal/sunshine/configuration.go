package sunshine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

var ErrConfigurationConflict = errors.New("encoder configuration changed; reload before saving")
var ErrConfigurationInvalid = errors.New("invalid encoder configuration patch")

// EncoderConfiguration is an internal snapshot, never a public API response:
// values can contain credentials and command arguments.
type EncoderConfiguration struct {
	Revision string
	Values   map[string]json.RawMessage
	State    *EncoderConfigurationState
}

// EncoderConfigurationState proves which file was read at startup, not that
// every option was accepted by the native parser or overrides are absent.
type EncoderConfigurationState struct {
	Status           bool     `json:"status"`
	SchemaVersion    int      `json:"schema_version"`
	Revision         string   `json:"revision"`
	ApplyPolicy      string   `json:"apply_policy"`
	RuntimeAvailable bool     `json:"runtime_available"`
	LoadedRevision   string   `json:"loaded_revision"`
	InstanceID       string   `json:"instance_id"`
	OverriddenKeys   []string `json:"overridden_keys"`
	RestartRequired  *bool    `json:"restart_required"`
}

func (c *Client) ConfigurationState(ctx context.Context) (*EncoderConfigurationState, error) {
	var state EncoderConfigurationState
	if err := c.requestManagedJSON(ctx, http.MethodGet, "/api/stream-kit/configuration-state", nil, 65536, &state); err != nil {
		return nil, err
	}
	if !state.Status || state.SchemaVersion != 1 || !configurationRevision(state.Revision) || state.ApplyPolicy != "encoder_restart" {
		return nil, errors.New("invalid encoder configuration state")
	}
	if state.RuntimeAvailable {
		if !configurationRevision(state.LoadedRevision) || !configurationRevision(`"`+state.InstanceID+`"`) || state.RestartRequired == nil || *state.RestartRequired != (state.Revision != state.LoadedRevision) || state.OverriddenKeys == nil {
			return nil, errors.New("incomplete encoder startup evidence")
		}
	} else if state.LoadedRevision != "" || state.InstanceID != "" || state.RestartRequired != nil {
		return nil, errors.New("contradictory encoder startup evidence")
	}
	return &state, nil
}

func configurationRevision(value string) bool {
	if len(value) != 66 || value[0] != '"' || value[65] != '"' {
		return false
	}
	for _, c := range value[1:65] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// configurationRequest deliberately does not retry writes after transport errors:
// the encoder might already have committed the requested revision.
func (c *Client) configurationRequest(ctx context.Context, method, revision string, payload []byte) (map[string]json.RawMessage, string, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+"/api/config", bytes.NewReader(payload))
	if err != nil {
		return nil, "", err
	}
	c.setBasicAuth(req)
	if method == http.MethodPost {
		token, err := c.GetCSRFToken(ctx)
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", token)
		req.Header.Set("If-Match", revision)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("encoder configuration request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden {
		c.invalidateCSRF()
	}
	if method == http.MethodPost && resp.StatusCode == http.StatusBadRequest {
		return nil, "", ErrConfigurationInvalid
	}
	if resp.StatusCode == http.StatusPreconditionFailed {
		return nil, "", ErrConfigurationConflict
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("encoder configuration request failed (HTTP %d); reload before retrying", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	if err != nil || len(body) > 2<<20 {
		return nil, "", errors.New("encoder configuration response unreadable or too large")
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(body, &result) != nil || string(result["status"]) != "true" {
		return nil, "", errors.New("encoder configuration acknowledgement invalid; reload before retrying")
	}
	etag := resp.Header.Get("ETag")
	if !configurationRevision(etag) {
		return nil, "", errors.New("encoder configuration revision missing or invalid; reload before retrying")
	}
	return result, etag, nil
}

func (c *Client) ReadConfiguration(ctx context.Context) (EncoderConfiguration, error) {
	values, revision, err := c.configurationRequest(ctx, http.MethodGet, "", nil)
	if err != nil {
		return EncoderConfiguration{}, err
	}
	for _, key := range []string{"status", "platform", "version"} {
		delete(values, key)
	}
	state, err := c.ConfigurationState(ctx)
	if err != nil {
		return EncoderConfiguration{}, err
	}
	if state.Revision != revision {
		return EncoderConfiguration{}, ErrConfigurationConflict
	}
	return EncoderConfiguration{Revision: revision, Values: values, State: state}, nil
}

// PatchConfiguration merges explicitly changed native keys into a fresh snapshot.
// The final native If-Match protects the read/merge/write interval as well.
// A nil JSON value removes an override, restoring the encoder default.
func (c *Client) PatchConfiguration(ctx context.Context, expected string, changes map[string]json.RawMessage) (string, error) {
	if !configurationRevision(expected) || len(changes) == 0 || len(changes) > 256 {
		return "", ErrConfigurationInvalid
	}
	for key, value := range changes {
		if len(key) == 0 || len(key) > 128 || key == "status" || key == "platform" || key == "version" {
			return "", ErrConfigurationInvalid
		}
		for _, ch := range key {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_') {
				return "", ErrConfigurationInvalid
			}
		}
		if !json.Valid(value) {
			return "", ErrConfigurationInvalid
		}
	}
	snapshot, err := c.ReadConfiguration(ctx)
	if err != nil {
		return "", err
	}
	if snapshot.Revision != expected {
		return "", ErrConfigurationConflict
	}
	for key, value := range changes {
		snapshot.Values[key] = value
	}
	payload, err := json.Marshal(snapshot.Values)
	if err != nil || len(payload) > 1<<20 {
		return "", ErrConfigurationInvalid
	}
	result, revision, err := c.configurationRequest(ctx, http.MethodPost, expected, payload)
	if err != nil {
		return "", err
	}
	if string(result["apply_policy"]) != `"encoder_restart"` {
		return "", errors.New("encoder configuration apply policy invalid; reload before retrying")
	}
	return revision, nil
}

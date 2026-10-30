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

// EncoderConfiguration is an internal snapshot, never a public API response:
// values can contain credentials and command arguments.
type EncoderConfiguration struct {
	Revision string
	Values   map[string]json.RawMessage
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
	return EncoderConfiguration{Revision: revision, Values: values}, nil
}

// PatchConfiguration merges explicitly changed native keys into a fresh snapshot.
// The final native If-Match protects the read/merge/write interval as well.
// A nil JSON value removes an override, restoring the encoder default.
func (c *Client) PatchConfiguration(ctx context.Context, expected string, changes map[string]json.RawMessage) (string, error) {
	if !configurationRevision(expected) || len(changes) == 0 || len(changes) > 256 {
		return "", errors.New("invalid encoder configuration patch")
	}
	for key, value := range changes {
		if len(key) == 0 || len(key) > 128 || key == "status" || key == "platform" || key == "version" {
			return "", errors.New("invalid encoder configuration key")
		}
		for _, ch := range key {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_') {
				return "", errors.New("invalid encoder configuration key")
			}
		}
		if !json.Valid(value) {
			return "", errors.New("invalid encoder configuration value")
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
		return "", errors.New("encoder configuration exceeds request limit")
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

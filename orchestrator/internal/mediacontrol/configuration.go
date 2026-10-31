package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

const configurationRequestContext = "stream-kit/gateway-configuration/request/v1\n"
const configurationResponseContext = "stream-kit/gateway-configuration/response/v1\n"

var ErrConfigurationConflict = errors.New("gateway configuration changed")
var ErrConfigurationInvalid = errors.New("gateway configuration rejected")
var ErrConfigurationUnavailable = errors.New("gateway configuration unavailable")

type GatewayConfiguration struct {
	Revision        string                     `json:"revision"`
	RunningRevision *string                    `json:"running_revision"`
	Runtime         *GatewayRuntimeIdentity    `json:"runtime,omitempty"`
	RestartRequired bool                       `json:"restart_required"`
	ApplyPolicy     string                     `json:"apply_policy"`
	Values          map[string]json.RawMessage `json:"values"`
	RedactedPaths   []string                   `json:"redacted_paths"`
	OverriddenPaths []string                   `json:"overridden_paths"`
}

// Runtime identity is authenticated by the configuration response signature.
// It is evidence for a restart, not permission to terminate an arbitrary PID.
type GatewayRuntimeIdentity struct {
	ProcessID  uint32 `json:"process_id"`
	InstanceID string `json:"instance_id"`
}

// GatewayConfiguration uses the native owner's versioned file operation. It
// neither parses native fields nor holds the media lease publisher mutex.
func (p *NodeClient) GatewayConfiguration(ctx context.Context, revision string, changes map[string]json.RawMessage) (*GatewayConfiguration, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, ErrConfigurationUnavailable
	}
	request := struct {
		SchemaVersion int                        `json:"schema_version"`
		RequestID     string                     `json:"request_id"`
		IssuedAt      int64                      `json:"issued_at_ms"`
		Operation     string                     `json:"operation"`
		Revision      string                     `json:"revision,omitempty"`
		Changes       map[string]json.RawMessage `json:"changes,omitempty"`
	}{1, hex.EncodeToString(nonce), time.Now().UnixMilli(), "read", revision, changes}
	if changes != nil {
		if revision == "" || len(changes) == 0 || len(changes) > 256 {
			return nil, ErrConfigurationInvalid
		}
		request.Operation = "save"
	}
	body, err := json.Marshal(request)
	if err != nil || len(body) > 256*1024 {
		return nil, ErrConfigurationInvalid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/internal/v1/configuration", bytes.NewReader(body))
	if err != nil {
		return nil, ErrConfigurationUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(controlSignatureHeader, controlSignature(p.secret, configurationRequestContext, body))
	response, err := p.client.Do(req)
	if err != nil {
		return nil, ErrConfigurationUnavailable
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || len(p.secret) == 0 {
		return nil, ErrConfigurationUnavailable
	}
	received, err := hex.DecodeString(response.Header.Get(controlSignatureHeader))
	expected, _ := hex.DecodeString(controlSignature(p.secret, configurationResponseContext, raw))
	if err != nil || !hmac.Equal(received, expected) {
		return nil, ErrConfigurationUnavailable
	}
	var envelope struct {
		SchemaVersion int    `json:"schema_version"`
		RequestID     string `json:"request_id"`
		IssuedAt      int64  `json:"request_issued_at_ms"`
		Result        struct {
			Status  string                `json:"status"`
			Code    string                `json:"code"`
			Message string                `json:"message"`
			Data    *GatewayConfiguration `json:"data"`
		} `json:"result"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || decoder.Decode(new(any)) != io.EOF || envelope.SchemaVersion != 1 || envelope.RequestID != request.RequestID || envelope.IssuedAt != request.IssuedAt || time.Now().UnixMilli()-request.IssuedAt > 5000 {
		return nil, ErrConfigurationUnavailable
	}
	if envelope.Result.Status == "error" {
		switch envelope.Result.Code {
		case "CONFIGURATION_CONFLICT":
			if response.StatusCode == 409 {
				return nil, ErrConfigurationConflict
			}
		case "CONFIGURATION_INVALID":
			if response.StatusCode == 400 {
				return nil, ErrConfigurationInvalid
			}
		}
		return nil, ErrConfigurationUnavailable
	}
	view := envelope.Result.Data
	if response.StatusCode != 200 || envelope.Result.Status != "ok" || view == nil || len(view.Revision) != 64 || view.ApplyPolicy != "gateway_restart" || view.Values == nil || view.RedactedPaths == nil || view.OverriddenPaths == nil {
		return nil, ErrConfigurationUnavailable
	}
	if view.RunningRevision != nil {
		decoded, err := hex.DecodeString(*view.RunningRevision)
		if err != nil || len(decoded) != 32 || view.RestartRequired != (*view.RunningRevision != view.Revision) {
			return nil, ErrConfigurationUnavailable
		}
	}
	if view.Runtime != nil {
		instance, err := hex.DecodeString(view.Runtime.InstanceID)
		if err != nil || len(instance) != 16 || view.Runtime.ProcessID == 0 {
			return nil, ErrConfigurationUnavailable
		}
	}
	return view, nil
}

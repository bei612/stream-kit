package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/stream-kit/orchestrator/internal/identity"
)

const nodeAudioRequestContext = "stream-kit/node-audio-state/request/v1\n"
const nodeAudioResponseContext = "stream-kit/node-audio-state/response/v1\n"

// NodeAudioState is a receiver projection of authoritative sessions. Local
// endpoints refer to this node, not the source media gateway. Bindings must be
// built by the control plane, never copied from browser claims.
type NodeAudioState struct {
	SchemaVersion int                          `json:"schema_version"`
	NodeID        string                       `json:"node_id"`
	InstanceID    string                       `json:"instance_id"`
	State         Envelope                     `json:"state"`
	Bindings      []identity.MicrophoneBinding `json:"bindings"`
}

type NodeAudioAcknowledgement struct {
	SchemaVersion      int    `json:"schema_version"`
	NodeID             string `json:"node_id"`
	InstanceID         string `json:"instance_id"`
	StateIssuedAt      int64  `json:"state_issued_at_ms"`
	ObservedAt         int64  `json:"observed_at_ms"`
	AuthorizedSessions int    `json:"authorized_sessions"`
}

// ApplyNodeAudioState acknowledges authorization only, never device opening or
// audio delivery. A failed update must not be treated as lease renewal.
func (p *NodeClient) ApplyNodeAudioState(ctx context.Context, state NodeAudioState) (*NodeAudioAcknowledgement, error) {
	body, err := json.Marshal(state)
	if err != nil || len(body) > 256*1024 {
		return nil, fmt.Errorf("invalid node audio state")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/internal/v1/node-audio-state", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(controlSignatureHeader, controlSignature(p.secret, nodeAudioRequestContext, body))
	response, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("node audio state rejected: HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return nil, fmt.Errorf("invalid node audio acknowledgement size")
	}
	received, err := hex.DecodeString(response.Header.Get(controlSignatureHeader))
	expected, _ := hex.DecodeString(controlSignature(p.secret, nodeAudioResponseContext, raw))
	if err != nil || len(p.secret) == 0 || !hmac.Equal(received, expected) {
		return nil, fmt.Errorf("unauthenticated node audio acknowledgement")
	}
	var ack NodeAudioAcknowledgement
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&ack) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("invalid node audio acknowledgement")
	}
	now := time.Now().UnixMilli()
	if ack.SchemaVersion != 1 || ack.NodeID != state.NodeID || ack.InstanceID != state.InstanceID || ack.StateIssuedAt != state.State.IssuedAt ||
		ack.AuthorizedSessions != len(state.Bindings) || ack.ObservedAt < state.State.IssuedAt-2000 || ack.ObservedAt > now+2000 || now >= state.State.ExpiresAt {
		return nil, fmt.Errorf("mismatched or stale node audio acknowledgement")
	}
	return &ack, nil
}

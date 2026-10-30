package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const audioRequestContext = "stream-kit/audio-devices/request/v1\n"
const audioResponseContext = "stream-kit/audio-devices/response/v1\n"
const audioSignatureHeader = "X-Stream-Control-Signature"
const audioMaxBytes = 1 << 20

type AudioDevice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Input  bool   `json:"input"`
	Output bool   `json:"output"`
}

type AudioEndpointPair struct {
	RenderDeviceID  string `json:"render_device_id"`
	CaptureDeviceID string `json:"capture_device_id"`
}

type AudioRoute struct {
	HostID   uint32            `json:"host_id"`
	AppID    uint32            `json:"app_id"`
	Endpoint AudioEndpointPair `json:"endpoint"`
}

type audioInventoryRequest struct {
	SchemaVersion uint32 `json:"schema_version"`
	RequestID     string `json:"request_id"`
	IssuedAt      int64  `json:"issued_at_ms"`
}

type AudioInventory struct {
	SchemaVersion    uint32        `json:"schema_version"`
	RequestID        string        `json:"request_id"`
	RequestIssuedAt  int64         `json:"request_issued_at_ms"`
	ObservedAt       int64         `json:"observed_at_ms"`
	Devices          []AudioDevice `json:"devices"`
	ConfiguredRoutes []AudioRoute  `json:"configured_routes"`
}

func audioSignature(secret []byte, domain string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(domain))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// AudioDevices enumerates in the gateway's OS user context, on explicit demand.
// It must not hold the state publisher mutex or delay control-lease renewal.
func (p *Publisher) AudioDevices(ctx context.Context) (AudioInventory, error) {
	var empty AudioInventory
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return empty, err
	}
	request := audioInventoryRequest{SchemaVersion: 1, RequestID: hex.EncodeToString(nonce[:]), IssuedAt: time.Now().UnixMilli()}
	body, err := json.Marshal(request)
	if err != nil {
		return empty, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/internal/v1/audio-devices", bytes.NewReader(body))
	if err != nil {
		return empty, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(audioSignatureHeader, audioSignature(p.secret, audioRequestContext, body))
	resp, err := p.client.Do(req)
	if err != nil {
		return empty, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return empty, fmt.Errorf("audio inventory rejected: HTTP %d", resp.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, audioMaxBytes+1))
	if err != nil {
		return empty, err
	}
	return decodeAudioInventory(p.secret, resp.Header.Get(audioSignatureHeader), responseBody, request, time.Now().UnixMilli())
}

func decodeAudioInventory(secret []byte, signature string, body []byte, request audioInventoryRequest, now int64) (AudioInventory, error) {
	var inventory AudioInventory
	raw, err := hex.DecodeString(signature)
	if err != nil || len(raw) != sha256.Size || len(body) > audioMaxBytes || len(secret) == 0 {
		return inventory, fmt.Errorf("invalid audio inventory signature or size")
	}
	want, _ := hex.DecodeString(audioSignature(secret, audioResponseContext, body))
	if !hmac.Equal(raw, want) {
		return inventory, fmt.Errorf("unauthenticated audio inventory")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&inventory); err != nil {
		return inventory, fmt.Errorf("invalid audio inventory: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return inventory, fmt.Errorf("trailing audio inventory data")
	}
	if inventory.SchemaVersion != 1 || inventory.RequestID != request.RequestID || inventory.RequestIssuedAt != request.IssuedAt ||
		now < request.IssuedAt || now-request.IssuedAt > 5000 ||
		inventory.ObservedAt < request.IssuedAt-2000 || inventory.ObservedAt > now+2000 ||
		inventory.Devices == nil || inventory.ConfiguredRoutes == nil {
		return inventory, fmt.Errorf("mismatched or stale audio inventory")
	}
	seen := make(map[string]bool, len(inventory.Devices))
	for _, device := range inventory.Devices {
		if device.ID == "" || seen[device.ID] {
			return inventory, fmt.Errorf("invalid audio device identity")
		}
		seen[device.ID] = true
	}
	// Configured devices may be absent: that is useful diagnostic information,
	// not permission to silently substitute the system default device.
	return inventory, nil
}

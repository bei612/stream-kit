package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

const pairRequestContext = "stream-kit/audio-pair-check/request/v1\n"
const pairResponseContext = "stream-kit/audio-pair-check/response/v1\n"

type PairMeasurement struct {
	CapturedFrames uint64  `json:"captured_frames"`
	ToneAmplitude  float64 `json:"tone_amplitude"`
	RMS            float64 `json:"rms"`
	Peak           float64 `json:"peak"`
	Quiet          bool    `json:"quiet"`
}
type PairCheckResult struct {
	Passed               *bool               `json:"passed"`
	CapturedFrames       uint64              `json:"captured_frames"`
	ToneAmplitude        float64             `json:"tone_amplitude"`
	SubmittedPackets     uint32              `json:"submitted_packets"`
	Target               *TargetDeviceStatus `json:"target"`
	Baseline             *PairMeasurement    `json:"baseline"`
	AfterClear           *PairMeasurement    `json:"after_clear"`
	DrainBeforeSilenceMS uint32              `json:"drain_before_silence_ms"`
	ClosedAfterDrop      bool                `json:"closed_after_drop"`
}
type pairCheckRequest struct {
	SchemaVersion uint32            `json:"schema_version"`
	RequestID     string            `json:"request_id"`
	IssuedAt      int64             `json:"issued_at_ms"`
	Endpoint      AudioEndpointPair `json:"endpoint"`
}
type pairCheckResponse struct {
	SchemaVersion   uint32          `json:"schema_version"`
	RequestID       string          `json:"request_id"`
	RequestIssuedAt int64           `json:"request_issued_at_ms"`
	ObservedAt      int64           `json:"observed_at_ms"`
	Result          PairCheckResult `json:"result"`
}

// CheckAudioPair is an explicit active test. It never retries a request which
// may already have opened devices; the native gateway owns cancellation cleanup.
func (p *Publisher) CheckAudioPair(ctx context.Context, pair AudioEndpointPair) (PairCheckResult, error) {
	var empty PairCheckResult
	inventory, err := p.AudioDevices(ctx)
	if err != nil {
		return empty, err
	}
	output, input := false, false
	for _, d := range inventory.Devices {
		if d.ID == pair.RenderDeviceID && d.Output {
			output = true
		}
		if d.ID == pair.CaptureDeviceID && d.Input {
			input = true
		}
	}
	if !output || !input || pair.RenderDeviceID == pair.CaptureDeviceID {
		return empty, fmt.Errorf("invalid endpoint pair")
	}
	for _, id := range []string{pair.RenderDeviceID, pair.CaptureDeviceID} {
		if len(id) > 4096 || strings.TrimSpace(id) != id || strings.ContainsAny(id, "\r\n\x00") {
			return empty, fmt.Errorf("invalid endpoint identity")
		}
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return empty, err
	}
	request := pairCheckRequest{1, hex.EncodeToString(nonce[:]), time.Now().UnixMilli(), pair}
	body, err := json.Marshal(request)
	if err != nil {
		return empty, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/internal/v1/audio-pair-check", bytes.NewReader(body))
	if err != nil {
		return empty, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(controlSignatureHeader, controlSignature(p.secret, pairRequestContext, body))
	client := *p.client
	client.Timeout = 15 * time.Second
	response, err := client.Do(req)
	if err != nil {
		return empty, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return empty, fmt.Errorf("audio pair check rejected: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil {
		return empty, err
	}
	return decodePairCheck(p.secret, response.Header.Get(controlSignatureHeader), data, request, time.Now().UnixMilli())
}
func decodePairCheck(secret []byte, signature string, body []byte, request pairCheckRequest, now int64) (PairCheckResult, error) {
	var response pairCheckResponse
	fail := func() (PairCheckResult, error) {
		return PairCheckResult{}, fmt.Errorf("invalid or unverified audio pair result")
	}
	expected, _ := hex.DecodeString(controlSignature(secret, pairResponseContext, body))
	actual, err := hex.DecodeString(signature)
	if len(secret) == 0 || len(body) > 65536 || err != nil || !hmac.Equal(actual, expected) {
		return fail()
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&response) != nil || decoder.Decode(new(any)) != io.EOF {
		return fail()
	}
	if response.SchemaVersion != 1 || response.RequestID != request.RequestID || response.RequestIssuedAt != request.IssuedAt || now < request.IssuedAt || now-request.IssuedAt > 15000 || response.ObservedAt < request.IssuedAt-2000 || response.ObservedAt > now+2000 {
		return fail()
	}
	result := response.Result
	if result.Passed == nil || result.Target == nil || result.Baseline == nil || result.AfterClear == nil || math.IsNaN(result.ToneAmplitude) || math.IsInf(result.ToneAmplitude, 0) {
		return fail()
	}
	quiet := func(m *PairMeasurement) bool {
		return m.Quiet && m.CapturedFrames >= 12000 && m.RMS >= 0 && m.RMS < 0.001 && m.Peak >= 0 && m.Peak < 0.003
	}
	if *result.Passed && (result.SubmittedPackets < 140 || result.CapturedFrames <= 48000 || result.ToneAmplitude <= 0.01 || !quiet(result.Baseline) || !quiet(result.AfterClear) || !result.Target.DeviceOpen || result.Target.Error != nil || !result.ClosedAfterDrop) {
		return fail()
	}
	return result, nil
}

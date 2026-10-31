package mediacontrol

import (
	"context"
	"encoding/json"
	"github.com/stream-kit/orchestrator/internal/session"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPairCheckUsesVerifiedInventoryAndBoundRequest(t *testing.T) {
	for _, badSignature := range []bool{false, true} {
		checks := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var output []byte
			var domain string
			if r.URL.Path == "/internal/v2/audio-devices" {
				var request audioInventoryRequest
				_ = json.Unmarshal(body, &request)
				if r.Header.Get(controlSignatureHeader) != controlSignature([]byte("key"), audioRequestContext, body) {
					t.Error("wrong inventory request signature")
				}
				output, _ = json.Marshal(AudioInventory{InstanceID: "0123456789abcdef0123456789abcdef", SchemaVersion: 2, RequestID: request.RequestID, RequestIssuedAt: request.IssuedAt, ObservedAt: time.Now().UnixMilli(), Devices: []AudioDevice{{ID: "out", Output: true}, {ID: "in", Input: true}}, ConfiguredRoutes: []AudioRoute{}})
				domain = audioResponseContext
			} else if r.URL.Path == "/internal/v1/audio-pair-check" {
				checks++
				var request pairCheckRequest
				_ = json.Unmarshal(body, &request)
				if request.Endpoint.RenderDeviceID != "out" || request.Endpoint.CaptureDeviceID != "in" || r.Header.Get(controlSignatureHeader) != controlSignature([]byte("key"), pairRequestContext, body) {
					t.Error("wrong pair request")
				}
				no := false
				output, _ = json.Marshal(pairCheckResponse{SchemaVersion: 1, RequestID: request.RequestID, RequestIssuedAt: request.IssuedAt, ObservedAt: time.Now().UnixMilli(), Result: PairCheckResult{Passed: &no, Target: &TargetDeviceStatus{}, Baseline: &PairMeasurement{}, AfterClear: &PairMeasurement{}}})
				domain = pairResponseContext
				if badSignature {
					domain = pairRequestContext
				}
			} else {
				t.Error("unexpected endpoint")
				w.WriteHeader(404)
				return
			}
			w.Header().Set(controlSignatureHeader, controlSignature([]byte("key"), domain, output))
			_, _ = w.Write(output)
		}))
		p := New(session.NewManager(nil), server.URL, "key")
		result, err := p.CheckAudioPair(context.Background(), AudioEndpointPair{RenderDeviceID: "out", CaptureDeviceID: "in"})
		server.Close()
		if checks != 1 || (err != nil) != badSignature {
			t.Fatalf("checks=%d badSignature=%v err=%v", checks, badSignature, err)
		}
		if !badSignature && (result.Passed == nil || *result.Passed) {
			t.Fatal("failed measurement was not preserved")
		}
	}
}

func TestPairCheckResponseBindingAndEvidence(t *testing.T) {
	yes := true
	request := pairCheckRequest{SchemaVersion: 1, RequestID: "nonce", IssuedAt: 10000}
	baseline := &PairMeasurement{CapturedFrames: 24000, Quiet: true}
	valid := pairCheckResponse{SchemaVersion: 1, RequestID: "nonce", RequestIssuedAt: 10000, ObservedAt: 14500, Result: PairCheckResult{Passed: &yes, CapturedFrames: 144000, ToneAmplitude: 0.1, SubmittedPackets: 150, Target: &TargetDeviceStatus{DeviceOpen: true}, Baseline: baseline, AfterClear: baseline, ClosedAfterDrop: true}}
	for _, tc := range []struct {
		name   string
		change func(*pairCheckResponse)
		valid  bool
	}{
		{"valid", func(*pairCheckResponse) {}, true},
		{"wrong request", func(r *pairCheckResponse) { r.RequestID = "other" }, false},
		{"missing result", func(r *pairCheckResponse) { r.Result.Passed = nil }, false},
		{"false positive", func(r *pairCheckResponse) { r.Result.ToneAmplitude = 0 }, false},
		{"device remains open", func(r *pairCheckResponse) { r.Result.ClosedAfterDrop = false }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := valid
			tc.change(&r)
			body, _ := json.Marshal(r)
			sig := controlSignature([]byte("key"), pairResponseContext, body)
			_, err := decodePairCheck([]byte("key"), sig, body, request, 15000)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
	body, _ := json.Marshal(valid)
	for _, domain := range []string{pairRequestContext, audioResponseContext} {
		if _, err := decodePairCheck([]byte("key"), controlSignature([]byte("key"), domain, body), body, request, 15000); err == nil {
			t.Fatal("accepted wrong signature domain")
		}
	}
	if _, err := decodePairCheck([]byte("key"), controlSignature([]byte("key"), pairResponseContext, body), body, request, 26000); err == nil {
		t.Fatal("accepted stale result")
	}
}

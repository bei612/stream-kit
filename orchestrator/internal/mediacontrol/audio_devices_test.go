package mediacontrol

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/session"
)

func TestAudioInventoryResponseBoundary(t *testing.T) {
	secret := []byte("inventory-test")
	request := audioInventoryRequest{1, "0123456789abcdef0123456789abcdef", 1700000000000}
	fixture := AudioInventory{1, request.RequestID, request.IssuedAt, request.IssuedAt,
		[]AudioDevice{{"wasapi:render", "Virtual cable", false, true}},
		[]AudioRoute{{1, 2, AudioEndpointPair{"wasapi:render", "missing:capture"}}}}
	for _, tc := range []struct {
		name           string
		mutate         func(*AudioInventory)
		domain, suffix string
		now            int64
		valid          bool
	}{
		{name: "missing configured endpoint is observable", valid: true},
		{name: "wrong nonce", mutate: func(v *AudioInventory) { v.RequestID = "another" }},
		{name: "wrong request time", mutate: func(v *AudioInventory) { v.RequestIssuedAt-- }},
		{name: "wrong version", mutate: func(v *AudioInventory) { v.SchemaVersion++ }},
		{name: "stale device observation", mutate: func(v *AudioInventory) { v.ObservedAt -= 2001 }},
		{name: "future device observation", mutate: func(v *AudioInventory) { v.ObservedAt += 2001 }},
		{name: "replayed response", now: request.IssuedAt + 5001},
		{name: "clock rollback", now: request.IssuedAt - 1},
		{name: "duplicate device identity", mutate: func(v *AudioInventory) { v.Devices = append(v.Devices, v.Devices[0]) }},
		{name: "missing devices", mutate: func(v *AudioInventory) { v.Devices = nil }},
		{name: "wrong signature domain", domain: audioRequestContext},
		{name: "trailing JSON", suffix: "{}"},
		{name: "oversize body", suffix: strings.Repeat(" ", audioMaxBytes)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := fixture
			if tc.mutate != nil {
				tc.mutate(&value)
			}
			body, _ := json.Marshal(value)
			body = append(body, tc.suffix...)
			domain := tc.domain
			if domain == "" {
				domain = audioResponseContext
			}
			now := tc.now
			if now == 0 {
				now = request.IssuedAt
			}
			_, err := decodeAudioInventory(secret, audioSignature(secret, domain, body), body, request, now)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t, error=%v", tc.valid, err)
			}
		})
	}
	body, _ := json.Marshal(fixture)
	signature := audioSignature(secret, audioResponseContext, body)
	for _, key := range [][]byte{nil, []byte("other")} {
		if _, err := decodeAudioInventory(key, signature, body, request, request.IssuedAt); err == nil {
			t.Fatal("wrong key accepted")
		}
	}
	if _, err := decodeAudioInventory(secret, signature, append(body, ' '), request, request.IssuedAt); err == nil {
		t.Fatal("tamper accepted")
	}
}

func TestAudioInventoryUsesConfiguredGatewayAndDoesNotBlockState(t *testing.T) {
	secret := []byte("inventory-test")
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.Path != "/gateway/internal/v1/audio-devices" || r.Header.Get(audioSignatureHeader) != audioSignature(secret, audioRequestContext, body) {
			t.Error("invalid signed inventory request")
			w.WriteHeader(401)
			return
		}
		var request audioInventoryRequest
		if json.Unmarshal(body, &request) != nil || len(request.RequestID) != 32 || request.SchemaVersion != 1 {
			t.Error("invalid request envelope")
		}
		close(entered)
		<-release
		body, _ = json.Marshal(AudioInventory{1, request.RequestID, request.IssuedAt, time.Now().UnixMilli(), []AudioDevice{}, []AudioRoute{}})
		w.Header().Set(audioSignatureHeader, audioSignature(secret, audioResponseContext, body))
		_, _ = w.Write(body)
	}))
	defer server.Close()
	p := New(session.NewManager(nil), server.URL+"/gateway/", string(secret))
	done := make(chan error, 1)
	go func() { _, err := p.AudioDevices(context.Background()); done <- err }()
	<-entered
	// The same mutex protects lease snapshots. Enumeration must never own it.
	available := p.mu.TryLock()
	if available {
		p.mu.Unlock()
	}
	close(release)
	if !available {
		t.Fatal("device enumeration blocks control-state synchronization")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestAudioInventoryRefusesRedirects(t *testing.T) {
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	p := New(session.NewManager(nil), redirect.URL, "secret")
	if _, err := p.AudioDevices(context.Background()); err == nil || calls.Load() != 0 {
		t.Fatal("signed request followed redirect")
	}
}

func TestAudioTargetSelectionUsesSignedInventoryDirections(t *testing.T) {
	var enumerations atomic.Int32
	secret := []byte("selection-test")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/v3/media-state" {
			var request Envelope
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				t.Error("state request")
				w.WriteHeader(400)
				return
			}
			writeAcknowledgement(t, w, request, string(secret))
			return
		}
		enumerations.Add(1)
		var request audioInventoryRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("inventory request")
			w.WriteHeader(400)
			return
		}
		body, _ := json.Marshal(AudioInventory{1, request.RequestID, request.IssuedAt, time.Now().UnixMilli(),
			[]AudioDevice{{"render", "Output", false, true}, {"capture", "Input", true, false}}, []AudioRoute{}})
		w.Header().Set(audioSignatureHeader, audioSignature(secret, audioResponseContext, body))
		_, _ = w.Write(body)
	}))
	defer server.Close()
	p := New(session.NewManager(nil), server.URL, string(secret))
	if err := p.ValidateAudioTarget(context.Background(), session.AudioTarget{Mode: "disabled"}); err != nil {
		t.Fatal(err)
	}
	if enumerations.Load() != 0 {
		t.Fatal("non-local selection enumerated devices")
	}
	for _, tc := range []struct {
		render, capture string
		valid           bool
	}{{"render", "capture", true}, {"capture", "render", false}, {"missing", "capture", false}} {
		err := p.ValidateAudioTarget(context.Background(), session.AudioTarget{Mode: "local", RenderDeviceID: tc.render, CaptureDeviceID: tc.capture})
		if tc.valid && err != nil {
			t.Fatal(err)
		}
		if !tc.valid && !errors.Is(err, session.ErrInvalidState) {
			t.Fatal("invalid selection accepted", err)
		}
	}
}

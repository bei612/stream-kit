package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/session"
	"go.uber.org/zap"
)

func TestCrossLanguageContract(t *testing.T) {
	body, err := os.ReadFile("../../../contracts/media-state/v1.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	body = bytes.TrimSpace(body)
	var envelope Envelope
	if err = json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, encoded) {
		t.Fatal("Go contract diverged from shared fixture")
	}
	mac := hmac.New(sha256.New, []byte("contract-test-secret"))
	mac.Write([]byte(SigningContext))
	mac.Write(body)
	if hex.EncodeToString(mac.Sum(nil)) != "b3efbc5198168d4923d53aaca0cfc4453d773a349712e0249a0e4b556623d98c" {
		t.Fatal("wire signature changed")
	}
}

func TestPublisherReconcilesCommittedChangesAndStops(t *testing.T) {
	manager := session.NewManager(nil)
	received := make(chan Envelope, 32)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, []byte("secret"))
		mac.Write([]byte(SigningContext))
		mac.Write(body)
		signature, _ := hex.DecodeString(r.Header.Get("X-Stream-State-Signature"))
		if r.Method != http.MethodPost || r.URL.Path != "/internal/v1/media-state" || !hmac.Equal(signature, mac.Sum(nil)) {
			t.Error("invalid signed request")
			w.WriteHeader(401)
			return
		}
		var envelope Envelope
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		received <- envelope
		writeAcknowledgement(t, w, envelope, "secret")
	}))
	defer server.Close()
	p := New(manager, server.URL, "secret")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { p.Run(ctx, zap.NewNop()); close(done) }()
	await := func(predicate func(Envelope) bool) Envelope {
		t.Helper()
		timeout := time.NewTimer(2 * time.Second)
		defer timeout.Stop()
		for {
			select {
			case e := <-received:
				if predicate(e) {
					return e
				}
			case <-timeout.C:
				t.Fatal("state did not converge")
				return Envelope{}
			}
		}
	}
	first := await(func(e Envelope) bool { return len(e.Sessions) == 0 })
	s, err := manager.Ensure(2636897928, 609885969)
	if err != nil {
		t.Fatal(err)
	}
	c, err := manager.AddConnection(s.ID, "user")
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	claimed := await(func(e Envelope) bool { return len(e.Sessions) == 1 && e.Sessions[0].ControllerID == c.ID })
	if claimed.IssuedAt <= first.IssuedAt || claimed.ExpiresAt-claimed.IssuedAt != 10000 || claimed.Sessions[0].Revision != 3 {
		t.Fatal("invalid lease or revision")
	}
	if err = manager.Disconnect(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	await(func(e Envelope) bool {
		return len(e.Sessions) == 1 && e.Sessions[0].Revision == 4 && e.Sessions[0].ControllerID == "" && len(e.Sessions[0].Connections) == 0
	})
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("publisher did not stop")
	}
}

func TestPublisherDoesNotFollowRedirectOrAcceptFailure(t *testing.T) {
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true; w.WriteHeader(204) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	p := New(session.NewManager(nil), server.URL, "secret")
	if err := p.Sync(context.Background()); err == nil {
		t.Fatal("redirect accepted")
	}
	if leaked {
		t.Fatal("signed state leaked to redirect target")
	}
	if p.Status().Reachable || p.Status().LeaseValid {
		t.Fatal("failed sync reported applied")
	}
}

func TestFailedSyncPreservesOnlyPreviousAcknowledgement(t *testing.T) {
	statusCode := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if statusCode != http.StatusOK {
			w.WriteHeader(statusCode)
			return
		}
		var envelope Envelope
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Error(err)
			return
		}
		writeAcknowledgement(t, w, envelope, "secret")
	}))
	defer server.Close()
	m := session.NewManager(nil)
	s, _ := m.Ensure(1, 2)
	p := New(m, server.URL, "secret")
	if err := p.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := p.Status(); !got.Reachable || !got.LeaseValid || got.Revisions[s.ID] != 1 {
		t.Fatal("missing acknowledgement")
	}
	_, _ = m.AddConnection(s.ID, "client")
	statusCode = http.StatusServiceUnavailable
	if err := p.Sync(context.Background()); err == nil {
		t.Fatal("gateway failure accepted")
	}
	got := p.Status()
	if got.Reachable || got.Revisions[s.ID] != 1 {
		t.Fatal("unacknowledged revision reported applied")
	}
	got.Revisions[s.ID] = 999
	if p.Status().Revisions[s.ID] != 1 {
		t.Fatal("status exposed mutable publisher state")
	}
	if got.ObservationsValid {
		t.Fatal("failed sync reported fresh observations")
	}
}

func writeAcknowledgement(t *testing.T, w http.ResponseWriter, request Envelope, secret string) {
	t.Helper()
	ack := Acknowledgement{SchemaVersion: 1, StateIssuedAt: request.IssuedAt, ObservedAt: time.Now().UnixMilli(), Sessions: []SessionObservation{}}
	for _, session := range request.Sessions {
		ack.Sessions = append(ack.Sessions, SessionObservation{SessionID: session.ID, Revision: session.Revision, MicrophoneTarget: TargetObservation{State: "unconfigured"}})
	}
	body, err := json.Marshal(ack)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ObservationSigningContext))
	mac.Write(body)
	w.Header().Set("X-Stream-Observation-Signature", hex.EncodeToString(mac.Sum(nil)))
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

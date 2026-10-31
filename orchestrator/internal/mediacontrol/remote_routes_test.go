package mediacontrol

import (
	"context"
	"encoding/json"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/session"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRemoteRoutePublishesReceiverBeforeSourceAndRevokesWithoutEnumeration(t *testing.T) {
	const nodeSecret = "target-node-independent-secret-0123456789"
	const sourceSecret = "source-node-independent-secret-0123456789"
	const instance = "0123456789abcdef0123456789abcdef"
	inventories, receiverWrites, sourceWrites := 0, 0, 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var response any
		domain := ""
		if r.URL.Path == "/node/internal/v2/audio-devices" {
			inventories++
			var request audioInventoryRequest
			_ = json.Unmarshal(body, &request)
			if r.Header.Get(controlSignatureHeader) != controlSignature([]byte(nodeSecret), audioRequestContext, body) {
				t.Error("inventory signature")
			}
			response = AudioInventory{InstanceID: instance, SchemaVersion: 2, RequestID: request.RequestID, RequestIssuedAt: request.IssuedAt, ObservedAt: time.Now().UnixMilli(), Devices: []AudioDevice{}, ConfiguredRoutes: []AudioRoute{}}
			domain = audioResponseContext
		} else {
			receiverWrites++
			var state NodeAudioState
			_ = json.Unmarshal(body, &state)
			if r.Header.Get(controlSignatureHeader) != controlSignature([]byte(nodeSecret), nodeAudioRequestContext, body) {
				t.Error("receiver signature")
			}
			if state.InstanceID != instance || state.State.Sessions[0].Audio.Target.Mode != "local" || state.State.Sessions[0].Audio.Target.NodeID != "" {
				t.Error("invalid receiver projection")
			}
			if (receiverWrites == 1 && len(state.Bindings) != 1) || (receiverWrites == 2 && len(state.Bindings) != 0) {
				t.Error("grant/revocation projection")
			}
			response = NodeAudioAcknowledgement{1, state.NodeID, instance, state.State.IssuedAt, time.Now().UnixMilli(), len(state.Bindings)}
			domain = nodeAudioResponseContext
		}
		raw, _ := json.Marshal(response)
		w.Header().Set(controlSignatureHeader, controlSignature([]byte(nodeSecret), domain, raw))
		_, _ = w.Write(raw)
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sourceWrites++
		body, _ := io.ReadAll(r.Body)
		var route microphoneRoute
		_ = json.Unmarshal(body, &route)
		if receiverWrites != 1 || r.Header.Get(controlSignatureHeader) != controlSignature([]byte(sourceSecret), "stream-kit/node-microphone-route/request/v1\n", body) {
			t.Error("source order/signature")
		}
		key, _ := identity.MicrophoneNodeKey([]byte(nodeSecret), "renderer-a")
		if _, err := identity.VerifyMicrophone(route.Token, key, route.Binding, time.Now()); err != nil {
			t.Error(err)
		}
		if route.URL != "ws"+target.URL[4:]+"/node/internal/v1/node-microphone/session-a" {
			t.Error("wrong target address")
		}
		raw, _ := json.Marshal(map[string]any{"schema_version": 1, "issued_at_ms": route.IssuedAt, "target_instance_id": instance, "session_id": route.Binding.SessionID, "target_epoch": route.Binding.TargetEpoch, "control_epoch": route.Binding.ControlEpoch, "connected": true})
		w.Header().Set(controlSignatureHeader, controlSignature([]byte(sourceSecret), "stream-kit/node-microphone-route/response/v1\n", raw))
		_, _ = w.Write(raw)
	}))
	defer source.Close()
	now := time.Now()
	p := New(session.NewManager(nil), source.URL, sourceSecret)
	p.status = Status{Reachable: true, AcknowledgedAt: now.UnixMilli(), LeaseExpiresAt: now.Add(10 * time.Second).UnixMilli(), Revisions: map[string]uint64{"session-a": 7}, Observations: map[string]SessionObservation{"session-a": {UpstreamActive: true}}}
	s := &session.RenderSession{ID: "session-a", HostID: 1, AppID: 2, Revision: 7, ControlEpoch: 5, ControllerConnectionID: "client-a", Audio: session.AudioConfig{MicrophoneEnabled: true, Target: session.AudioTarget{Mode: "remote", NodeID: "renderer-a", Epoch: 3, RenderDeviceID: "out", CaptureDeviceID: "in"}}, Connections: map[string]*session.Connection{"client-a": {ID: "client-a", ExpiresAt: now.Add(10 * time.Second)}}}
	instances := map[string]string{}
	client := NewNodeClient(target.URL+"/node", nodeSecret)
	if err := p.reconcileNodeRoutes(context.Background(), "renderer-a", client, []*session.RenderSession{s}, instances, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	s.Audio.MicrophoneEnabled = false
	if err := p.reconcileNodeRoutes(context.Background(), "renderer-a", client, []*session.RenderSession{s}, instances, now.UnixMilli()+1); err != nil {
		t.Fatal(err)
	}
	if inventories != 1 || receiverWrites != 2 || sourceWrites != 1 {
		t.Fatalf("inventory=%d receiver=%d source=%d", inventories, receiverWrites, sourceWrites)
	}
}

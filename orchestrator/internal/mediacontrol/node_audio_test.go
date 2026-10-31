package mediacontrol

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestNodeAudioAcknowledgementBindsReceiverInstanceAndSnapshot(t *testing.T) {
	fixture, err := os.ReadFile("../../../contracts/audio-devices/node-state-v1.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var state NodeAudioState
	if err := json.Unmarshal(fixture, &state); err != nil {
		t.Fatal(err)
	}
	state.State.IssuedAt = time.Now().UnixMilli()
	state.State.ExpiresAt = state.State.IssuedAt + 10000
	for _, mode := range []string{"valid", "instance", "node", "revision", "count", "signature", "stale", "unknown", "oversize"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if r.URL.Path != "/prefix/internal/v1/node-audio-state" || r.Method != "POST" || r.Header.Get(controlSignatureHeader) != controlSignature([]byte("test-key"), nodeAudioRequestContext, body) {
					t.Error("invalid signed node request")
					w.WriteHeader(401)
					return
				}
				ack := NodeAudioAcknowledgement{1, state.NodeID, state.InstanceID, state.State.IssuedAt, time.Now().UnixMilli(), 1}
				switch mode {
				case "instance":
					ack.InstanceID = "different-boot"
				case "node":
					ack.NodeID = "other"
				case "revision":
					ack.StateIssuedAt--
				case "count":
					ack.AuthorizedSessions = 0
				case "stale":
					ack.ObservedAt = state.State.IssuedAt - 2001
				}
				raw, _ := json.Marshal(ack)
				if mode == "unknown" {
					raw = append(raw[:len(raw)-1], []byte(",\"unexpected\":true}")...)
				}
				if mode == "oversize" {
					raw = append(raw, make([]byte, 4097)...)
				}
				domain := nodeAudioResponseContext
				if mode == "signature" {
					domain = nodeAudioRequestContext
				}
				w.Header().Set(controlSignatureHeader, controlSignature([]byte("test-key"), domain, raw))
				_, _ = w.Write(raw)
			}))
			defer server.Close()
			ack, err := NewNodeClient(server.URL+"/prefix", "test-key").ApplyNodeAudioState(context.Background(), state)
			if (err == nil) != (mode == "valid") {
				t.Fatalf("ack=%+v, error=%v", ack, err)
			}
		})
	}
}

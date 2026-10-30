package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
	"github.com/stream-kit/orchestrator/internal/session"
	"go.uber.org/zap"
)

func TestManagedClientAdmissionAndAuthorityBoundaries(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request mediacontrol.Envelope
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		ack := mediacontrol.Acknowledgement{SchemaVersion: 1, StateIssuedAt: request.IssuedAt, ObservedAt: time.Now().UnixMilli(), Sessions: []mediacontrol.SessionObservation{}}
		for _, item := range request.Sessions {
			ack.Sessions = append(ack.Sessions, mediacontrol.SessionObservation{SessionID: item.ID, Revision: item.Revision, MicrophoneTarget: mediacontrol.TargetObservation{State: "unconfigured"}})
		}
		body, _ := json.Marshal(ack)
		mac := hmac.New(sha256.New, []byte("media-secret"))
		mac.Write([]byte(mediacontrol.ObservationSigningContext))
		mac.Write(body)
		w.Header().Set("X-Stream-Observation-Signature", hex.EncodeToString(mac.Sum(nil)))
		_, _ = w.Write(body)
	}))
	defer gateway.Close()
	cfg := &config.Config{Server: config.ServerConfig{Username: "admin", Password: "test-password", JWTSecret: "management-secret", MediaTicketSecret: "media-secret"}, MoonlightWeb: config.MoonlightWebConfig{BaseURL: gateway.URL}}
	manager := session.NewManager(nil)
	server := New(cfg, nil, nil, nil, nil, manager, zap.NewNop())
	request := func(method, path, token string, body any, status int) map[string]any {
		t.Helper()
		encoded, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		server.Engine.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: status %d, want %d; %s", method, path, rec.Code, status, rec.Body.String())
		}
		var result struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &result)
		return result.Data
	}
	login := request("POST", "/api/v1/login", "", map[string]string{"username": "admin", "password": "test-password"}, 200)
	admin := login["token"].(string)
	request("POST", "/api/v1/stream-invitations", "", map[string]int{"host_id": 1, "app_id": 2}, 401)
	request("GET", "/api/v1/config?token="+admin, "", nil, 401)
	invitation := request("POST", "/api/v1/stream-invitations", admin, map[string]int{"host_id": 1, "app_id": 2}, 200)["invitation"].(string)
	request("POST", "/api/v1/client-sessions/join", admin, nil, 401)
	request("GET", "/api/v1/config", invitation, nil, 401)
	a := request("POST", "/api/v1/client-sessions/join", invitation, map[string]string{"user_id": "admin"}, 200)
	b := request("POST", "/api/v1/client-sessions/join", invitation, nil, 200)
	token := a["connection_token"].(string)
	sid := a["session_id"].(string)
	ac := a["connection"].(map[string]any)
	aid := ac["connection_id"].(string)
	bid := b["connection"].(map[string]any)["connection_id"].(string)
	if !strings.HasPrefix(ac["user_id"].(string), "guest:") || ac["role"] != "viewer" {
		t.Fatal("client supplied trusted identity")
	}
	prefix := "/api/v1/client-sessions/" + sid + "/connections/"
	request("GET", "/api/v1/config", token, nil, 401)
	request("POST", "/api/v1/stream-sessions/"+sid+"/controller/"+aid, token, nil, 401)
	request("GET", prefix+bid, token, nil, 401)
	request("DELETE", prefix+bid, token, nil, 401)
	request("POST", prefix+bid+"/ticket", token, nil, 401)
	request("GET", prefix+aid, invitation, nil, 401)
	current := request("GET", prefix+aid, token, nil, 200)
	if _, ok := current["connections"]; ok {
		t.Fatal("client response leaked other clients")
	}
	heartbeat := request("POST", prefix+aid+"/heartbeat", token, map[string]bool{"microphone": true, "microphone_live": true}, 200)
	if heartbeat["connection"].(map[string]any)["microphone_live"] != false {
		t.Fatal("viewer became live controller")
	}
	token = heartbeat["connection_token"].(string)
	ticket := request("POST", prefix+aid+"/ticket", token, nil, 200)["ticket"].(string)
	request("GET", prefix+aid, ticket, nil, 401)
	observed, _ := manager.Get(sid)
	if err := manager.Transfer(sid, aid, "", observed.ControlEpoch); err != nil {
		t.Fatal(err)
	}
	heartbeat = request("POST", prefix+aid+"/heartbeat", token, map[string]bool{"microphone": true, "microphone_live": true}, 200)
	if heartbeat["connection"].(map[string]any)["role"] != "controller" {
		t.Fatal("authoritative role not propagated")
	}
	request("DELETE", "/api/v1/stream-sessions/"+sid+"/connections/"+aid, admin, nil, 200)
	request("POST", prefix+aid+"/heartbeat", token, map[string]bool{}, 410)
	request("POST", prefix+aid+"/ticket", token, nil, 410)
	if err := manager.SetState(sid, session.StateStopped); err != nil {
		t.Fatal(err)
	}
	request("POST", "/api/v1/client-sessions/join", invitation, nil, 400)
}

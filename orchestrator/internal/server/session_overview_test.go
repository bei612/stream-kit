package server

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"github.com/stream-kit/orchestrator/internal/session"
	"go.uber.org/zap"
)

func TestSessionOverviewRequiresManagementIdentityAndPreservesPendingState(t *testing.T) {
	cfg := &config.Config{
		Server:       config.ServerConfig{Username: "admin", Password: "test-password", JWTSecret: "management-secret", MediaTicketSecret: "media-secret"},
		MoonlightWeb: config.MoonlightWebConfig{BaseURL: "http://127.0.0.1:1"},
	}
	manager := session.NewManager(nil)
	s, err := manager.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	server := New(cfg, nil, nil, nil, nil, manager, zap.NewNop())
	claims := handlers.Claims{Sub: "admin", Iat: time.Now().Unix(), Exp: time.Now().Unix() + 60}
	key := handlers.ResolveJWTSecret(cfg.Server.JWTSecret, cfg.Server.Password)
	for _, tc := range []struct {
		token  string
		status int
	}{
		{"", 401},
		{identity.Sign(identity.Connection, claims, key), 401},
		{identity.Sign(identity.Management, claims, key), 200},
	} {
		req := httptest.NewRequest("GET", "/api/v1/stream-sessions/overview", nil)
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		rec := httptest.NewRecorder()
		server.Engine.ServeHTTP(rec, req)
		if rec.Code != tc.status {
			t.Fatalf("status %d, want %d", rec.Code, tc.status)
		}
		if rec.Code != 200 {
			continue
		}
		var response struct {
			Data mediacontrol.Overview `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if rec.Header().Get("Cache-Control") != "no-store" || response.Data.SampledAt <= 0 ||
			len(response.Data.Sessions) != 1 || response.Data.Sessions[0].ID != s.ID || response.Data.Media.Reachable || response.Data.Media.ObservationsValid {
			t.Fatal("overview invented media readiness, omitted current sessions or allowed caching")
		}
	}
	// A genuinely unconfigured publisher still permits listing durable sessions.
	cfg.MoonlightWeb = config.MoonlightWebConfig{}
	server = New(cfg, nil, nil, nil, nil, manager, zap.NewNop())
	req := httptest.NewRequest("GET", "/api/v1/stream-sessions/overview", nil)
	req.Header.Set("Authorization", "Bearer "+identity.Sign(identity.Management, claims, key))
	rec := httptest.NewRecorder()
	server.Engine.ServeHTTP(rec, req)
	var response struct {
		Data mediacontrol.Overview `json:"data"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &response) != nil || len(response.Data.Sessions) != 1 ||
		response.Data.Media.Reachable || response.Data.Media.Revisions == nil || response.Data.Media.Observations == nil {
		t.Fatal("missing publisher hid sessions or omitted the media status shape")
	}
}

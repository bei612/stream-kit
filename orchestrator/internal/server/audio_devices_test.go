package server

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"go.uber.org/zap"
)

func TestAudioInventoryRequiresManagementIdentity(t *testing.T) {
	key := "management-secret"
	cfg := &config.Config{Server: config.ServerConfig{Username: "admin", Password: "test-password", JWTSecret: key}}
	server := New(cfg, nil, nil, nil, nil, nil, zap.NewNop())
	claims := handlers.Claims{Sub: "admin", Iat: time.Now().Unix(), Exp: time.Now().Unix() + 60}
	signingKey := handlers.ResolveJWTSecret(key, cfg.Server.Password)
	for _, tc := range []struct {
		token  string
		status int
	}{
		{"", 401},
		{identity.Sign(identity.Connection, claims, signingKey), 401},
		{identity.Sign(identity.Management, claims, signingKey), 503},
	} {
		req := httptest.NewRequest("GET", "/api/v1/audio-devices", nil)
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		rec := httptest.NewRecorder()
		server.Engine.ServeHTTP(rec, req)
		if rec.Code != tc.status {
			t.Fatalf("status %d, want %d", rec.Code, tc.status)
		}
		if rec.Code == 503 && rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("inventory response can be cached")
		}
	}
}

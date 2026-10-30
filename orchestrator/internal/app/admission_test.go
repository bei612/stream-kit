package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/moonlight"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestViewingAdmissionAndDeletionShareLifecycle(t *testing.T) {
	m, st, req := localFixture(t)
	a, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateAppFields(a.ID, map[string]interface{}{"sunshine_app_id": 771}); err != nil {
		t.Fatal(err)
	}
	deleting, release := make(chan struct{}), make(chan struct{})
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/login":
			http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
		case "/api/hosts":
			_ = json.NewEncoder(w).Encode(map[string]any{"hosts": []moonlight.Host{{HostID: 1}}})
		case "/api/apps":
			_ = json.NewEncoder(w).Encode(map[string]any{"apps": []moonlight.App{{AppID: 771}}})
		case "/api/stream-kit/capabilities":
			_ = json.NewEncoder(w).Encode(sunshine.Capabilities{SchemaVersion: 1, ManagedAppsVersion: 1, ManagedRuntimeVersion: 1, CaptureModes: []model.CaptureMode{model.CaptureDesktop}, CaptureModeApply: "application_restart"})
		case "/api/csrf-token":
			_, _ = w.Write([]byte(`{"csrf_token":"fixture"}`))
		case "/api/stream-kit/runtime":
			_ = json.NewEncoder(w).Encode(sunshine.Runtime{SchemaVersion: 1})
		case "/api/stream-kit/apps/" + a.ID:
			if r.Method == http.MethodDelete {
				close(deleting)
				<-release
			}
			_ = json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: a.ID, GameStreamID: 771, App: sunshine.SunshineApp{ManagedID: a.ID}})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer fixture.Close()
	defer close(release)
	m.moonClient = moonlight.NewClient(config.MoonlightWebConfig{BaseURL: fixture.URL}, zap.NewNop())
	m.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: fixture.URL}, zap.NewNop())
	sessions := session.NewManager(nil)
	m.ConfigureSessionLifecycle(sessions, func(context.Context) error { return nil })
	if _, err := m.EnsureViewingSession(context.Background(), 2, 771); !errors.Is(err, session.ErrInvalidState) {
		t.Fatalf("wrong host admitted: %v", err)
	}
	if _, err := m.EnsureViewingSession(context.Background(), 1, 772); !errors.Is(err, session.ErrNotFound) {
		t.Fatalf("unregistered app admitted: %v", err)
	}
	if _, err := m.EnsureViewingSession(context.Background(), 1, 771); err != nil {
		t.Fatal(err)
	}
	deleted := make(chan error, 1)
	go func() { deleted <- m.DeleteApp(a.ID) }()
	select {
	case <-deleting:
	case <-time.After(5 * time.Second):
		t.Fatal("delete did not reach native acknowledgement")
	}
	// Native deletion is pending after the old viewing session is stopped.
	// This is precisely the old race window where Ensure could create a new one.
	admitted := make(chan error, 1)
	go func() { _, err := m.EnsureViewingSession(context.Background(), 1, 771); admitted <- err }()
	select {
	case err := <-admitted:
		t.Fatalf("admission escaped pending deletion: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	release <- struct{}{}
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
	if err := <-admitted; !errors.Is(err, session.ErrNotFound) {
		t.Fatalf("deleted app readmitted: %v", err)
	}
	for _, s := range sessions.List() {
		if s.State != session.StateStopped {
			t.Fatal("delete left a new active generation")
		}
	}
}

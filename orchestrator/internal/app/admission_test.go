package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/moonlight"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestAdmissionRecoversPersistedStopOnlyAfterAcknowledgements(t *testing.T) {
	testPersistedStopRecovery(t, false)
}

func TestSettingsRecoverPersistedStopOnlyAfterAcknowledgements(t *testing.T) {
	testPersistedStopRecovery(t, true)
}

func testPersistedStopRecovery(t *testing.T, updateSettings bool) {
	t.Helper()
	m, st, req := localFixture(t)
	a, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.UpdateAppFields(a.ID, map[string]interface{}{"sunshine_app_id": 771}); err != nil {
		t.Fatal(err)
	}
	sessions, err := session.NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	old, _ := sessions.Ensure(1, 771)
	sessions.BeginStop(1, 771)
	sessions, err = session.NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	var gatewayDown, encoderDown atomic.Bool
	var writes atomic.Int32
	gatewayDown.Store(true)
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/login":
			http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
		case "/api/hosts":
			json.NewEncoder(w).Encode(map[string]any{"hosts": []moonlight.Host{{HostID: 1}}})
		case "/api/host":
			writeRendererFixture(w, r, -1)
		case "/api/apps":
			json.NewEncoder(w).Encode(map[string]any{"apps": []moonlight.App{{AppID: 771}}})
		case "/api/stream-kit/capabilities":
			json.NewEncoder(w).Encode(sunshine.Capabilities{SchemaVersion: 1, ManagedAppsVersion: 1, ManagedRuntimeVersion: 1, CaptureModes: []model.CaptureMode{model.CaptureDesktop}, CaptureModeApply: "application_restart"})
		case "/api/stream-kit/apps/" + a.ID:
			projected := sunshine.SunshineApp{ManagedID: a.ID}
			if r.Method == http.MethodPut {
				writes.Add(1)
				if gatewayDown.Load() || encoderDown.Load() {
					t.Error("settings changed before stop acknowledgement")
				}
				if err := json.NewDecoder(r.Body).Decode(&projected); err != nil {
					t.Error(err)
				}
			}
			json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: a.ID, GameStreamID: 771, App: projected})
		case "/api/csrf-token":
			_, _ = w.Write([]byte(`{"csrf_token":"fixture"}`))
		case "/api/stream-kit/runtime":
			if gatewayDown.Load() {
				t.Error("native queried before gateway acknowledgement")
			}
			if encoderDown.Load() {
				w.WriteHeader(503)
				return
			}
			json.NewEncoder(w).Encode(sunshine.Runtime{SchemaVersion: 1})
		default:
			t.Error(r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer fixture.Close()
	m.moonClient = moonlight.NewClient(config.MoonlightWebConfig{BaseURL: fixture.URL}, zap.NewNop())
	m.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: fixture.URL}, zap.NewNop())
	m.ConfigureSessionLifecycle(sessions, func(context.Context) error {
		if gatewayDown.Load() {
			return errors.New("gateway unavailable")
		}
		return nil
	})
	for _, phase := range []string{"gateway unavailable", "encoder unavailable", "recovered"} {
		gatewayDown.Store(phase == "gateway unavailable")
		encoderDown.Store(phase == "encoder unavailable")
		var fresh *session.RenderSession
		args := "--updated-after-stop"
		if updateSettings {
			err = m.UpdateApp(a.ID, nil, &args, nil, nil)
		} else {
			fresh, err = m.EnsureViewingSession(context.Background(), 1, 771, time.Time{})
		}
		previous, _ := sessions.Get(old.ID)
		saved, readErr := st.GetApp(a.ID)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if phase != "recovered" {
			if err == nil || previous.State != session.StateStopping || saved.Args != a.Args || writes.Load() != 0 {
				t.Fatalf("admitted before ack: %s %v", phase, err)
			}
		} else {
			if err != nil || previous.State != session.StateStopped {
				t.Fatalf("recovery failed: %v", err)
			}
			if updateSettings {
				if saved.Args != args || writes.Load() != 1 || len(sessions.List()) != 1 {
					t.Fatal("settings recovery did not apply once or unexpectedly created a viewer")
				}
			} else if fresh.ID == old.ID {
				t.Fatal("old authority reused")
			}
		}
	}
	if _, err := sessions.AddConnection(old.ID, "stale invitation"); !errors.Is(err, session.ErrInvalidState) {
		t.Fatal("old authority reopened")
	}
}

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
		case "/api/host":
			writeRendererFixture(w, r, -1)
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
	if _, err := m.EnsureViewingSession(context.Background(), 2, 771, time.Time{}); !errors.Is(err, session.ErrInvalidState) {
		t.Fatalf("wrong host admitted: %v", err)
	}
	if _, err := m.EnsureViewingSession(context.Background(), 1, 772, time.Time{}); !errors.Is(err, session.ErrNotFound) {
		t.Fatalf("unregistered app admitted: %v", err)
	}
	if _, err := m.EnsureViewingSession(context.Background(), 1, 771, time.Time{}); err != nil {
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
	go func() { _, err := m.EnsureViewingSession(context.Background(), 1, 771, time.Time{}); admitted <- err }()
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

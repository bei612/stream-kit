package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestRestartRequiredSettingsRespectAuthoritativeLifecycle(t *testing.T) {
	for _, scenario := range []string{"starting_session", "native_running", "native_unavailable", "registration_failed", "idle", "pipeline_busy"} {
		t.Run(scenario, func(t *testing.T) {
			m, st, req := localFixture(t)
			a, err := m.RegisterLocal(req)
			if err != nil {
				t.Fatal(err)
			}
			if err := st.UpdateAppFields(a.ID, map[string]interface{}{"sunshine_app_id": 771}); err != nil {
				t.Fatal(err)
			}
			sessions := session.NewManager(nil)
			m.ConfigureSessionLifecycle(sessions, nil)
			if scenario == "starting_session" {
				if _, err := sessions.Ensure(1, 771); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "pipeline_busy" {
				unlock, err := m.TryLock(a.ID)
				if err != nil {
					t.Fatal(err)
				}
				defer unlock()
			}
			writes := 0
			fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/api/stream-kit/capabilities":
					_ = json.NewEncoder(w).Encode(sunshine.Capabilities{SchemaVersion: 1, ManagedAppsVersion: 1, ManagedRuntimeVersion: 1, CaptureModes: []model.CaptureMode{model.CaptureDesktop}, CaptureModeApply: "application_restart"})
				case r.URL.Path == "/api/stream-kit/runtime":
					if scenario == "native_unavailable" {
						w.WriteHeader(503)
						return
					}
					active := sunshine.Runtime{SchemaVersion: 1}
					if scenario == "native_running" {
						active.AppID = a.ID
						active.GameStreamID = 771
						active.InstanceID = "1234567890abcdef1234567890abcdef"
					}
					_ = json.NewEncoder(w).Encode(active)
				case r.URL.Path == "/api/csrf-token":
					_, _ = w.Write([]byte(`{"csrf_token":"fixture"}`))
				case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/api/stream-kit/apps/"):
					writes++
					if scenario == "registration_failed" {
						w.WriteHeader(503)
						return
					}
					var projected sunshine.SunshineApp
					if err := json.NewDecoder(r.Body).Decode(&projected); err != nil {
						t.Error(err)
					}
					_ = json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: a.ID, GameStreamID: 771, App: projected})
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer fixture.Close()
			m.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: fixture.URL}, zap.NewNop())
			args := "--new-settings"
			err = m.UpdateApp(a.ID, nil, &args, nil, nil)
			if (err == nil) != (scenario == "idle") {
				t.Fatalf("unexpected update outcome: %v", err)
			}
			saved, err := st.GetApp(a.ID)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "registration_failed":
				if writes != 1 || saved.Status != model.AppStatusRegisterFailed || saved.Args != args || saved.ErrorMessage == "" {
					t.Fatalf("failed desired settings not recoverable: %+v", saved)
				}
			case "idle":
				if writes != 1 || saved.Status != model.AppStatusReady || saved.Args != args {
					t.Fatalf("idle settings not applied: %+v", saved)
				}
			default:
				if writes != 0 || saved.Args != a.Args || saved.Status != a.Status {
					t.Fatalf("rejected settings mutated app: %+v", saved)
				}
			}
		})
	}
}

package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/moonlight"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestRuntimeReconciliationUsesPersistedIdentityAfterRestart(t *testing.T) {
	manager, store, request := localFixture(t)
	first, err := manager.RegisterLocal(request)
	if err != nil {
		t.Fatal(err)
	}
	request.Name = "Other local application"
	second, err := manager.RegisterLocal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateAppFields(first.ID, map[string]interface{}{"sunshine_app_id": 101}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateAppFields(second.ID, map[string]interface{}{"sunshine_app_id": 202}); err != nil {
		t.Fatal(err)
	}
	check := func(firstStatus, secondStatus model.AppStatus) {
		t.Helper()
		a, e1 := store.GetApp(first.ID)
		b, e2 := store.GetApp(second.ID)
		if e1 != nil || e2 != nil || a.Status != firstStatus || b.Status != secondStatus {
			t.Fatalf("runtime mismatch: %+v %+v %v %v", a, b, e1, e2)
		}
	}
	manager.reconcileStreaming(101)
	check(model.AppStatusRunning, model.AppStatusReady)
	// A direct app-to-app transition must be observed without an idle poll.
	manager.reconcileStreaming(202)
	check(model.AppStatusStopped, model.AppStatusRunning)
	// An unrelated program must never be attributed to the last opened app.
	manager.reconcileStreaming(303)
	check(model.AppStatusStopped, model.AppStatusStopped)
	manager.reconcileStreaming(0)
	check(model.AppStatusStopped, model.AppStatusStopped)
}

func TestLaunchConfirmsOwnedNativeRegistrationBeforeResolvingStream(t *testing.T) {
	for _, scenario := range []string{"matching", "matching_running", "stale_running", "changed_id", "missing_owner"} {
		t.Run(scenario, func(t *testing.T) {
			manager, store, request := localFixture(t)
			app, err := manager.RegisterLocal(request)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.UpdateAppFields(app.ID, map[string]interface{}{"sunshine_app_id": 771}); err != nil {
				t.Fatal(err)
			}
			if scenario == "matching_running" || scenario == "stale_running" {
				if err := store.UpdateAppFields(app.ID, map[string]interface{}{"status": model.AppStatusRunning, "stream_url": "stale-cached-url"}); err != nil {
					t.Fatal(err)
				}
			}
			gatewayReads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/serverinfo":
					current := 0
					if scenario == "matching_running" {
						current = 771
					}
					if scenario == "stale_running" {
						current = 999
					}
					_, _ = fmt.Fprintf(w, `<root status_code="200"><currentgame>%d</currentgame><state>SUNSHINE_SERVER_FREE</state></root>`, current)
				case "/api/stream-kit/capabilities":
					_, _ = w.Write([]byte(`{"schema_version":1,"capture_modes":["desktop"],"capture_mode_apply":"application_restart","managed_apps_version":1}`))
				case "/api/stream-kit/apps/" + app.ID:
					if scenario == "missing_owner" {
						w.WriteHeader(404)
						return
					}
					id := 771
					if scenario == "changed_id" {
						id = 772
					}
					_ = json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: app.ID, GameStreamID: id, App: sunshine.SunshineApp{ManagedID: app.ID}})
				case "/api/login":
					http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
				case "/api/hosts":
					gatewayReads++
					_, _ = w.Write([]byte(`{"hosts":[{"host_id":1}]}`))
				case "/api/apps":
					_, _ = w.Write([]byte(`{"apps":[{"app_id":771,"title":"Same display name"}]}`))
				default:
					t.Error(r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			manager.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: server.URL, ServerInfoURL: server.URL + "/serverinfo"}, zap.NewNop())
			manager.moonClient = moonlight.NewClient(config.MoonlightWebConfig{BaseURL: server.URL}, zap.NewNop())
			streamURL, err := manager.LaunchApp(app.ID)
			wantSuccess := scenario == "matching" || scenario == "matching_running"
			if (err == nil) != wantSuccess || streamURL == "stale-cached-url" {
				t.Fatal(scenario, err)
			}
			if !wantSuccess && gatewayReads != 0 {
				t.Fatal("resolved stream before confirming ownership")
			}
		})
	}
}

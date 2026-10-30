package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestStopAndDeleteRequireOwnedExecutionAcknowledgement(t *testing.T) {
	for _, operation := range []string{"stop", "delete"} {
		for _, scenario := range []string{"owned", "other", "idle", "stale_ready", "unreachable", "conflict", "wrong_ack", "restart_on_delete", "legacy"} {
			t.Run(operation+"/"+scenario, func(t *testing.T) {
				manager, store, request := localFixture(t)
				app, err := manager.RegisterLocal(request)
				if err != nil {
					t.Fatal(err)
				}
				initial := model.AppStatusRunning
				if scenario == "stale_ready" {
					initial = model.AppStatusReady
				}
				if err := store.UpdateAppFields(app.ID, map[string]interface{}{"sunshine_app_id": 771, "status": initial}); err != nil {
					t.Fatal(err)
				}
				stops, deletes := 0, 0
				instance := "1234567890abcdef1234567890abcdef"
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/api/stream-kit/capabilities":
						version := 1
						if scenario == "legacy" {
							version = 0
						}
						_ = json.NewEncoder(w).Encode(sunshine.Capabilities{SchemaVersion: 1, ManagedAppsVersion: 1, ManagedRuntimeVersion: version, CaptureModes: []model.CaptureMode{model.CaptureDesktop}, CaptureModeApply: "application_restart"})
					case "/api/csrf-token":
						_, _ = w.Write([]byte(`{"csrf_token":"fixture"}`))
					case "/api/stream-kit/runtime":
						if scenario == "unreachable" {
							w.WriteHeader(503)
							return
						}
						active := sunshine.Runtime{SchemaVersion: 1, AppID: app.ID, GameStreamID: 771, InstanceID: instance}
						if scenario == "other" {
							active.AppID = "22222222-2222-4222-8222-222222222222"
						}
						if scenario == "idle" {
							active = sunshine.Runtime{SchemaVersion: 1}
						}
						_ = json.NewEncoder(w).Encode(active)
					case "/api/stream-kit/apps/" + app.ID + "/stop":
						stops++
						var body map[string]string
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["instance_id"] != instance || r.Method != "POST" {
							t.Error("stop lost execution identity")
						}
						if scenario == "conflict" {
							w.WriteHeader(409)
							return
						}
						echo := instance
						if scenario == "wrong_ack" {
							echo = "ffffffffffffffffffffffffffffffff"
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"schema_version": 1, "app_id": app.ID, "instance_id": echo, "stopped": true})
					case "/api/stream-kit/apps/" + app.ID:
						deletes++
						if r.Method != "DELETE" {
							t.Error("unexpected registration mutation")
						}
						if scenario == "restart_on_delete" {
							w.WriteHeader(409)
							return
						}
						_ = json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: app.ID, GameStreamID: 771})
					default:
						t.Errorf("unsafe or unexpected native request: %s", r.URL.Path)
						w.WriteHeader(500)
					}
				}))
				defer server.Close()
				manager.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: server.URL}, zap.NewNop())
				if operation == "stop" {
					err = manager.StopApp(app.ID)
				} else {
					err = manager.DeleteApp(app.ID)
				}
				wantError := scenario == "unreachable" || scenario == "conflict" || scenario == "wrong_ack" || scenario == "legacy" || (operation == "delete" && scenario == "restart_on_delete")
				if (err != nil) != wantError {
					t.Fatalf("error=%v, wantError=%v", err, wantError)
				}
				if (scenario == "other" || scenario == "idle" || scenario == "legacy" || scenario == "unreachable") && stops != 0 {
					t.Fatal("stopped an unconfirmed owner")
				}
				if wantError && scenario != "restart_on_delete" && deletes != 0 {
					t.Fatal("deleted after failed stop")
				}
				saved, readErr := store.GetApp(app.ID)
				if wantError {
					if readErr != nil || saved.Status != initial {
						t.Fatal("failed operation changed database state")
					}
					if _, err := os.Stat(app.AppDir); err != nil {
						t.Fatal("failed operation removed owned files")
					}
				} else if operation == "stop" {
					if readErr != nil || saved.Status != model.AppStatusStopped {
						t.Fatal("confirmed stop did not update state")
					}
				} else if readErr == nil {
					t.Fatal("confirmed deletion kept registration")
				}
				if _, err := os.Stat(request.ExePath); err != nil {
					t.Fatal("external executable was removed")
				}
			})
		}
	}
}

package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/moonlight"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestApplicationStopRevokesBeforeNativeAndRetriesWithoutReadmission(t *testing.T) {
	for _, operation := range []string{"stop", "delete"} {
		for _, failure := range []string{"none", "host", "gateway", "native"} {
			t.Run(operation+"/"+failure, func(t *testing.T) {
				manager, st, request := localFixture(t)
				app, err := manager.RegisterLocal(request)
				if err != nil {
					t.Fatal(err)
				}
				if err := st.UpdateAppFields(app.ID, map[string]interface{}{"sunshine_app_id": 771, "status": model.AppStatusRunning}); err != nil {
					t.Fatal(err)
				}
				sessions, err := session.NewManagerWithStore(nil, st)
				if err != nil {
					t.Fatal(err)
				}
				s, _ := sessions.Ensure(1, 771)
				_, _ = sessions.AddConnection(s.ID, "viewer")
				unrelated, _ := sessions.Ensure(2, 772)
				var acknowledged, retry atomic.Bool
				var nativeStops atomic.Int32
				var authority atomic.Pointer[session.Manager]
				authority.Store(sessions)
				fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/api/login":
						http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
					case "/api/hosts":
						hostID := uint32(1)
						if failure == "host" && !retry.Load() {
							hostID = 2
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"hosts": []moonlight.Host{{HostID: hostID}}})
					case "/api/apps":
						_ = json.NewEncoder(w).Encode(map[string]any{"apps": []moonlight.App{{AppID: 771}}})
					case "/api/stream-kit/capabilities":
						_ = json.NewEncoder(w).Encode(sunshine.Capabilities{SchemaVersion: 1, ManagedAppsVersion: 1, ManagedRuntimeVersion: 1, CaptureModes: []model.CaptureMode{model.CaptureDesktop}, CaptureModeApply: "application_restart"})
					case "/api/csrf-token":
						_, _ = w.Write([]byte(`{"csrf_token":"fixture"}`))
					case "/api/stream-kit/runtime":
						if !acknowledged.Load() {
							t.Error("native stop began before gateway revocation acknowledgement")
						}
						_ = json.NewEncoder(w).Encode(sunshine.Runtime{SchemaVersion: 1, AppID: app.ID, GameStreamID: 771, InstanceID: "1234567890abcdef1234567890abcdef"})
					case "/api/stream-kit/apps/" + app.ID + "/stop":
						nativeStops.Add(1)
						if failure == "native" && !retry.Load() {
							w.WriteHeader(409)
							return
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"schema_version": 1, "app_id": app.ID, "instance_id": "1234567890abcdef1234567890abcdef", "stopped": true})
					case "/api/stream-kit/apps/" + app.ID:
						current, _ := authority.Load().Get(s.ID)
						if r.Method != "DELETE" || current.State != session.StateStopped {
							t.Error("unregister preceded confirmed stop")
						}
						_ = json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: app.ID, GameStreamID: 771})
					default:
						t.Error(r.URL.Path)
						w.WriteHeader(500)
					}
				}))
				defer fixture.Close()
				manager.moonClient = moonlight.NewClient(config.MoonlightWebConfig{BaseURL: fixture.URL}, zap.NewNop())
				manager.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: fixture.URL}, zap.NewNop())
				syncMedia := func(context.Context) error {
					current, _ := sessions.Get(s.ID)
					if current.State != session.StateStopping || len(current.Connections) != 0 {
						t.Fatal("media publication preceded durable revocation")
					}
					persisted, err := st.GetStreamSession(s.ID)
					if err != nil || persisted.State != session.StateStopping {
						t.Fatal("revocation was not durable")
					}
					if failure == "gateway" && !retry.Load() {
						return errors.New("gateway unavailable")
					}
					acknowledged.Store(true)
					return nil
				}
				manager.ConfigureSessionLifecycle(sessions, syncMedia)
				operate := manager.StopApp
				if operation == "delete" {
					operate = manager.DeleteApp
				}
				err = operate(app.ID)
				if failure != "none" {
					if err == nil {
						t.Fatal("failed operation reported success")
					}
					if (failure == "gateway" || failure == "host") && nativeStops.Load() != 0 {
						t.Fatal("native stopped before media acknowledgement")
					}
					current, _ := sessions.Get(s.ID)
					wantState := session.StateStopping
					if failure == "host" {
						wantState = s.State
					}
					if current.State != wantState {
						t.Fatal("failure reopened viewing")
					}
					saved, _ := st.GetApp(app.ID)
					if saved.Status != model.AppStatusRunning {
						t.Fatal("unconfirmed stop changed app status")
					}
					// Reconstruct authority from persisted data before retrying.
					sessions, err = session.NewManagerWithStore(nil, st)
					if err != nil {
						t.Fatal(err)
					}
					manager.ConfigureSessionLifecycle(sessions, syncMedia)
					authority.Store(sessions)
					retry.Store(true)
					err = operate(app.ID)
				}
				if err != nil {
					t.Fatal(err)
				}
				current, _ := sessions.Get(s.ID)
				other, _ := sessions.Get(unrelated.ID)
				if current.State != session.StateStopped || other.State != unrelated.State {
					t.Fatal("incorrect terminal scope")
				}
				if _, err := sessions.AddConnection(s.ID, "old invitation"); !errors.Is(err, session.ErrInvalidState) {
					t.Fatal("old viewer readmitted")
				}
			})
		}
	}
}

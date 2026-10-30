package sunshine

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

const managedTestID = "11111111-1111-4111-8111-111111111111"

func TestManagedApplicationUsesUUIDAndValidatesAcknowledgement(t *testing.T) {
	for _, scenario := range []string{"success", "wrong_owner", "wrong_version", "zero_game_id", "oversized", "storage_error", "legacy"} {
		t.Run(scenario, func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/stream-kit/capabilities":
					version := 1
					if scenario == "legacy" {
						version = 0
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"schema_version": 1, "capture_modes": []string{"desktop"}, "capture_mode_apply": "application_restart", "managed_apps_version": version})
				case "/api/csrf-token":
					_, _ = w.Write([]byte(`{"csrf_token":"fixture"}`))
				case "/api/stream-kit/apps/" + managedTestID:
					writes++
					if r.Method != http.MethodPut || r.Header.Get("X-CSRF-Token") != "fixture" {
						t.Errorf("unexpected write contract: %s", r.Method)
					}
					var app SunshineApp
					if err := json.NewDecoder(r.Body).Decode(&app); err != nil {
						t.Error(err)
					}
					if app.ManagedID != managedTestID {
						t.Errorf("missing owned identity: %+v", app)
					}
					result := ManagedApp{SchemaVersion: 1, AppID: managedTestID, GameStreamID: 771, App: app}
					switch scenario {
					case "wrong_owner":
						result.App.ManagedID = "22222222-2222-4222-8222-222222222222"
					case "wrong_version":
						result.SchemaVersion = 2
					case "zero_game_id":
						result.GameStreamID = 0
					case "oversized":
						_, _ = w.Write([]byte(strings.Repeat("x", 262145)))
						return
					case "storage_error":
						w.WriteHeader(http.StatusInternalServerError)
						return
					}
					_ = json.NewEncoder(w).Encode(result)
				default:
					t.Errorf("unsafe legacy API called: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL}, zap.NewNop())
			result, err := client.UpsertManagedApp(context.Background(), managedTestID, SunshineApp{Name: "Same name"})
			if (err == nil) != (scenario == "success") {
				t.Fatalf("unexpected outcome: %+v %v", result, err)
			}
			if scenario == "legacy" && writes != 0 {
				t.Fatal("mutated legacy backend")
			}
			if scenario == "success" && (result.GameStreamID != 771 || writes != 1) {
				t.Fatal(result, writes)
			}
		})
	}
}

func TestManagedApplicationRejectsNoncanonicalIdentityBeforeNetwork(t *testing.T) {
	client := NewClient(config.SunshineAPIConfig{BaseURL: "http://unused.invalid"}, zap.NewNop())
	for _, id := range []string{"", "../apps", "00000000-0000-0000-0000-000000000000", "AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa"} {
		if _, err := client.UpsertManagedApp(context.Background(), id, SunshineApp{Name: "Bad"}); err == nil {
			t.Fatal(id)
		}
	}
	if _, err := client.UpsertManagedApp(context.Background(), managedTestID, SunshineApp{ManagedID: "different"}); err == nil {
		t.Fatal("mismatched payload identity accepted")
	}
}

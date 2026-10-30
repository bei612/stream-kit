package sunshine

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestConfigurationPatchPreservesUntouchedAndChecksBothRevisions(t *testing.T) {
	old := `"` + strings.Repeat("a", 64) + `"`
	next := `"` + strings.Repeat("b", 64) + `"`
	for _, scenario := range []string{"success", "stale-read", "state-race", "concurrent-write", "missing-ack", "false-ack", "wrong-policy"} {
		t.Run(scenario, func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if user, pass, ok := r.BasicAuth(); !ok || user != "admin" || pass != "password" {
					t.Error("missing authentication")
				}
				if r.URL.Path == "/api/csrf-token" {
					_, _ = w.Write([]byte(`{"csrf_token":"token"}`))
					return
				}
				if r.Method == http.MethodGet {
					if r.URL.Path == "/api/stream-kit/configuration-state" {
						revision := old
						if scenario == "stale-read" || scenario == "state-race" {
							revision = next
						}
						_ = json.NewEncoder(w).Encode(map[string]any{"status": true, "schema_version": 1, "revision": revision, "apply_policy": "encoder_restart", "runtime_available": false})
						return
					}
					w.Header().Set("ETag", old)
					if scenario == "stale-read" {
						w.Header().Set("ETag", next)
					}
					_, _ = w.Write([]byte(`{"status":true,"platform":"windows","version":"test","private_key":"keep-secret","global_prep_cmd":"[\n{\"do\":\"echo hello\"}\n]","fps":"60"}`))
					return
				}
				writes++
				if r.Header.Get("If-Match") != old || r.Header.Get("X-CSRF-Token") != "token" {
					t.Error("missing transaction headers")
				}
				var payload map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if string(payload["private_key"]) != `"keep-secret"` || string(payload["fps"]) != `"30"` || string(payload["global_prep_cmd"]) != `"[\n{\"do\":\"echo hello\"}\n]"` || len(payload) != 3 {
					t.Errorf("incorrect merged payload keys: %d", len(payload))
				}
				if scenario == "concurrent-write" {
					w.WriteHeader(http.StatusPreconditionFailed)
					return
				}
				if scenario != "missing-ack" {
					w.Header().Set("ETag", next)
				}
				if scenario == "false-ack" {
					_, _ = w.Write([]byte(`{"status":false}`))
					return
				}
				if scenario == "wrong-policy" {
					_, _ = w.Write([]byte(`{"status":true,"apply_policy":"live"}`))
					return
				}
				_, _ = w.Write([]byte(`{"status":true,"apply_policy":"encoder_restart"}`))
			}))
			defer server.Close()
			client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL, Username: "admin", Password: "password"}, zap.NewNop())
			revision, err := client.PatchConfiguration(context.Background(), old, map[string]json.RawMessage{"fps": json.RawMessage(`"30"`)})
			if scenario == "success" {
				if err != nil || revision != next {
					t.Fatalf("save failed: %v", err)
				}
			} else if err == nil {
				t.Fatal("invalid transaction accepted")
			}
			if scenario == "stale-read" || scenario == "state-race" || scenario == "concurrent-write" {
				if !errors.Is(err, ErrConfigurationConflict) {
					t.Fatalf("missing conflict: %v", err)
				}
			}
			wantWrites := 1
			if scenario == "stale-read" || scenario == "state-race" {
				wantWrites = 0
			}
			if writes != wantWrites {
				t.Fatalf("writes=%d want=%d", writes, wantWrites)
			}
		})
	}
}

func TestConfigurationStateRequiresConsistentStartupEvidence(t *testing.T) {
	revision := `"` + strings.Repeat("a", 64) + `"`
	for _, scenario := range []string{"loaded", "pending", "unknown", "missing-version", "missing-restart", "missing-instance", "contradictory", "unknown-with-evidence"} {
		t.Run(scenario, func(t *testing.T) {
			state := map[string]any{"status": true, "schema_version": 1, "revision": revision, "apply_policy": "encoder_restart", "runtime_available": true, "loaded_revision": revision, "instance_id": strings.Repeat("b", 64), "restart_required": false, "overridden_keys": []string{"sunshine_name"}}
			switch scenario {
			case "pending":
				state["revision"] = `"` + strings.Repeat("c", 64) + `"`
				state["restart_required"] = true
			case "unknown":
				state = map[string]any{"status": true, "schema_version": 1, "revision": revision, "apply_policy": "encoder_restart", "runtime_available": false}
			case "missing-version":
				delete(state, "schema_version")
			case "missing-restart":
				delete(state, "restart_required")
			case "missing-instance":
				delete(state, "instance_id")
			case "contradictory":
				state["restart_required"] = true
			case "unknown-with-evidence":
				state["runtime_available"] = false
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(state) }))
			defer server.Close()
			client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL}, zap.NewNop())
			_, err := client.ConfigurationState(context.Background())
			valid := scenario == "loaded" || scenario == "pending" || scenario == "unknown"
			if (err == nil) != valid {
				t.Fatalf("unexpected state result: %v", err)
			}
		})
	}
}

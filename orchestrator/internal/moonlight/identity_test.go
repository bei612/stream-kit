package moonlight

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestManagedStreamLookupUsesIDAndRejectsAmbiguityOrUnreadableHosts(t *testing.T) {
	for _, scenario := range []string{"unique", "ambiguous", "host_error", "absent"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/login":
					http.SetCookie(w, &http.Cookie{Name: "mlSession", Value: "fixture"})
				case "/api/hosts":
					_ = json.NewEncoder(w).Encode(map[string]any{"hosts": []Host{{HostID: 1}, {HostID: 2}}})
				case "/api/apps":
					id := uint32(771)
					if r.URL.Query().Get("host_id") == "2" {
						if scenario == "host_error" {
							w.WriteHeader(500)
							return
						}
						if scenario != "ambiguous" {
							id = 772
						}
					}
					if scenario == "absent" {
						id = 772
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"apps": []App{{AppID: id, Title: "Same display name"}}})
				default:
					t.Error(r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			client := NewClient(config.MoonlightWebConfig{BaseURL: server.URL}, zap.NewNop())
			info, err := client.FindStreamInfoByID(context.Background(), 771)
			if (err == nil) != (scenario == "unique") {
				t.Fatalf("wrong lookup result: %+v %v", info, err)
			}
			if err == nil && (info.HostID != 1 || info.AppID != 771) {
				t.Fatal(info)
			}
		})
	}
}

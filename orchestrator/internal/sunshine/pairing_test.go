package sunshine

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestApprovePairingMatchesOnlyExactCertificate(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	for _, scenario := range []string{"success", "duplicate", "unrelated", "invalid", "rejected", "renew_csrf"} {
		t.Run(scenario, func(t *testing.T) {
			posts, reads, csrf := 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if name, password, ok := r.BasicAuth(); !ok || name != "owner" || password != "private-test" {
					t.Error("missing component authentication")
				}
				switch {
				case r.URL.Path == "/api/csrf-token":
					csrf++
					json.NewEncoder(w).Encode(map[string]string{"csrf_token": "test-csrf"})
				case r.Method == "GET" && r.URL.Path == "/api/pin":
					reads++
					pairings := []map[string]string{{"id": "unrelated", "client_certificate_sha256": strings.Repeat("cd", 32)}}
					if scenario != "unrelated" && reads > 1 {
						pairings = append(pairings, map[string]string{"id": "expected", "client_certificate_sha256": strings.ToUpper(digest)})
						if scenario == "duplicate" {
							pairings = append(pairings, map[string]string{"id": "duplicate", "client_certificate_sha256": digest})
						}
					}
					json.NewEncoder(w).Encode(map[string]any{"pairings": pairings})
				case r.Method == "POST" && r.URL.Path == "/api/pin":
					posts++
					if r.Header.Get("X-CSRF-Token") != "test-csrf" {
						t.Error("missing csrf")
					}
					var body map[string]string
					json.NewDecoder(r.Body).Decode(&body)
					if body["pairing_id"] != "expected" || body["pin"] != "0123" {
						t.Error("approved different request")
					}
					if scenario == "renew_csrf" && posts == 1 {
						w.WriteHeader(403)
						return
					}
					json.NewEncoder(w).Encode(map[string]bool{"status": scenario != "rejected"})
				default:
					t.Error(r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL, Username: "owner", Password: "private-test"}, zap.NewNop())
			ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
			defer cancel()
			fingerprint := digest
			if scenario == "invalid" {
				fingerprint = "invalid"
			}
			err := client.ApprovePairing(ctx, fingerprint, "0123")
			wantOK := scenario == "success" || scenario == "renew_csrf"
			if (err == nil) != wantOK {
				t.Fatalf("unexpected result: %v", err)
			}
			if !wantOK && scenario != "rejected" && posts != 0 {
				t.Fatal("unmatched approval mutated renderer")
			}
			if scenario == "invalid" && reads != 0 {
				t.Fatal("invalid challenge performed I/O")
			}
			if scenario == "renew_csrf" && (csrf != 2 || posts != 2) {
				t.Fatal("CSRF renewal not exercised")
			}
		})
	}
}

func TestRendererEndpointUsesConfiguredGameStreamPort(t *testing.T) {
	for _, tc := range []struct {
		base, explicit, address string
		port                    uint16
		valid                   bool
	}{
		{"https://127.0.0.1:48990", "", "127.0.0.1", 48989, true},
		{"", "http://[::1]:47989/serverinfo", "[::1]", 47989, true},
		{"", "http://renderer.local/serverinfo", "renderer.local", 80, true},
		{"", "https://renderer:47989/serverinfo", "", 0, false},
		{"", "http://user:secret@renderer:47989/serverinfo", "", 0, false},
	} {
		c := NewClient(config.SunshineAPIConfig{BaseURL: tc.base, ServerInfoURL: tc.explicit}, zap.NewNop())
		a, p, err := c.RendererEndpoint()
		if (err == nil) != tc.valid || a != tc.address || p != tc.port {
			t.Fatalf("endpoint: %q %d %v", a, p, err)
		}
	}
}

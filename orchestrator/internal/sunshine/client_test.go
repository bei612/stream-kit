package sunshine

import (
	"context"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServerInfoEndpoint(t *testing.T) {
	for _, tc := range []struct{ base, explicit, want string }{
		{"https://localhost:47990", "", "http://localhost:47989/serverinfo"},
		{"https://[::1]:48990/", "", "http://[::1]:48989/serverinfo"},
		{"https://proxy/sunshine", "http://127.0.0.1:47989/serverinfo", "http://127.0.0.1:47989/serverinfo"},
	} {
		c := NewClient(config.SunshineAPIConfig{BaseURL: tc.base, ServerInfoURL: tc.explicit}, zap.NewNop())
		got, err := c.serverInfoURL()
		if err != nil || got != tc.want {
			t.Fatalf("endpoint = %q, %v; want %q", got, err, tc.want)
		}
	}
	c := NewClient(config.SunshineAPIConfig{BaseURL: "https://proxy/sunshine"}, zap.NewNop())
	if _, err := c.serverInfoURL(); err == nil {
		t.Fatal("proxy endpoint requires explicit GameStream URL")
	}
}

func TestGetServerInfo(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   int
		bad    bool
	}{
		{"idle", 200, `<root status_code="200"><currentgame>0</currentgame><state>SUNSHINE_SERVER_FREE</state></root>`, 0, false},
		{"running", 200, `<root status_code="200"><currentgame>42</currentgame></root>`, 42, false},
		{"management404", 404, `{"status":false}`, 0, true},
		{"missingGame", 200, `<root><state>unknown</state></root>`, 0, true},
		{"invalidGame", 200, `<root><currentgame>invalid</currentgame></root>`, 0, true},
		{"protocolError", 200, `<root status_code="503"><currentgame>0</currentgame></root>`, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/serverinfo" {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				if r.Header.Get("Authorization") != "" {
					t.Error("management credentials sent to public GameStream endpoint")
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			c := NewClient(config.SunshineAPIConfig{BaseURL: "https://unused:47990", ServerInfoURL: server.URL + "/serverinfo", Username: "admin", Password: "secret"}, zap.NewNop())
			got, err := c.GetServerInfo(context.Background())
			if (err != nil) != tc.bad {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.bad && got.CurrentGame != tc.want {
				t.Fatalf("game = %d; want %d", got.CurrentGame, tc.want)
			}
		})
	}
}

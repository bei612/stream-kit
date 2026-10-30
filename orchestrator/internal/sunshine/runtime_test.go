package sunshine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestRuntimeRejectsIncompleteAndContradictorySnapshots(t *testing.T) {
	for _, body := range []string{
		`{"schema_version":1}`,
		`{"schema_version":1,"gamestream_id":null,"app_id":"","instance_id":""}`,
		`{"schema_version":2,"gamestream_id":0,"app_id":"","instance_id":""}`,
		`{"schema_version":1,"gamestream_id":0,"app_id":"","instance_id":"1234567890abcdef1234567890abcdef"}`,
		`{"schema_version":1,"gamestream_id":7,"app_id":"","instance_id":""}`,
		`{"schema_version":1,"gamestream_id":7,"app_id":"wrong","instance_id":"1234567890abcdef1234567890abcdef"}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/stream-kit/capabilities" {
					_, _ = w.Write([]byte(`{"schema_version":1,"capture_modes":["desktop"],"capture_mode_apply":"application_restart","managed_runtime_version":1}`))
				} else {
					_, _ = w.Write([]byte(body))
				}
			}))
			defer server.Close()
			client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL}, zap.NewNop())
			if _, err := client.Runtime(context.Background()); err == nil {
				t.Fatal("invalid runtime response accepted")
			}
		})
	}
}

package sunshine

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"go.uber.org/zap"
)

func TestCaptureCapabilitiesFailClosed(t *testing.T) {
	for _, test := range []struct {
		name      string
		status    int
		body      string
		supported bool
		invalid   bool
	}{
		{"current", 200, `{"schema_version":1,"capture_modes":["desktop","application"],"capture_mode_apply":"application_restart"}`, true, false},
		{"linux", 200, `{"schema_version":1,"capture_modes":["desktop"],"capture_mode_apply":"application_restart"}`, false, false},
		{"legacy", 404, `not found`, false, false},
		{"auth", 401, ``, false, true},
		{"offline", 503, ``, false, true},
		{"future", 200, `{"schema_version":2,"capture_modes":["desktop","application"],"capture_mode_apply":"application_restart"}`, false, true},
		{"bad apply", 200, `{"schema_version":1,"capture_modes":["desktop","application"],"capture_mode_apply":"live"}`, false, true},
		{"unknown mode", 200, `{"schema_version":1,"capture_modes":["desktop","window"],"capture_mode_apply":"application_restart"}`, false, true},
		{"duplicate", 200, `{"schema_version":1,"capture_modes":["application","application"],"capture_mode_apply":"application_restart"}`, false, true},
		{"extra data", 200, `{"schema_version":1,"capture_modes":["desktop","application"],"capture_mode_apply":"application_restart"}{}`, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					writes++
					t.Error("capability validation wrote upstream state")
				}
				if r.URL.Path != "/api/stream-kit/capabilities" {
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				user, password, ok := r.BasicAuth()
				if !ok || user != "admin" || password != "test-password" {
					t.Error("missing management authentication")
				}
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL, Username: "admin", Password: "test-password"}, zap.NewNop())
			_, err := client.Capabilities(context.Background())
			if (err != nil) != test.invalid {
				t.Fatalf("capability validation: %v", err)
			}
			err = client.RequireCaptureMode(context.Background(), model.CaptureApplication)
			if (err == nil) != test.supported {
				t.Fatalf("application support: %v", err)
			}
			if err = client.RequireCaptureMode(context.Background(), model.CaptureDesktop); err != nil {
				t.Fatal(err)
			}
			if !test.supported {
				err = client.CreateApp(context.Background(), SunshineApp{Name: "test", CaptureMode: model.CaptureApplication})
				if err == nil || writes != 0 {
					t.Fatal("unsupported application registration reached mutation")
				}
			}
		})
	}
}

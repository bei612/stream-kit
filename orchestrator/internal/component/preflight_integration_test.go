package component

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestNativeGatewayPreflight(t *testing.T) {
	executable := os.Getenv("STREAM_KIT_GATEWAY_EXE")
	if executable == "" {
		t.Skip("set STREAM_KIT_GATEWAY_EXE to the source-built gateway")
	}
	directory := t.TempDir()
	cfg := config.ComponentConfig{ExePath: executable, WorkingDir: directory,
		PreflightArgs: `--config-path "native config.json" config check`}
	path := filepath.Join(directory, "native config.json")
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{}`, true},
		{`{"webrtc":{"port_range":{"min":900,"max":800}}}`, false},
		{`{"web_server":{"first_login_create_admin":false,"first_login_assign_global_hosts":false,"certificate":{"certificate_pem":"missing.pem","private_key_pem":"missing.key"}}}`, false},
	} {
		if err := os.WriteFile(path, []byte(tc.body), 0600); err != nil {
			t.Fatal(err)
		}
		if err := preflight(context.Background(), cfg); (err == nil) != tc.valid {
			t.Fatalf("preflight valid=%v: %v", tc.valid, err)
		}
	}
	files, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("native preflight created runtime resources: %v", files)
	}
}

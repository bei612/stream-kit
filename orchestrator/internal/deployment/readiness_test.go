package deployment

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestReadinessRequiresMatchingBuildAndLiveAutostartComponents(t *testing.T) {
	cfg := &config.Config{Components: map[string]config.ComponentConfig{"sunshine": {AutoStart: true, ExePath: "sunshine.exe"}, "web_server": {AutoStart: true, ExePath: "web-server.exe"}, "disabled": {}}}
	for _, test := range []struct {
		name, body string
		code       int
		ready      bool
	}{
		{"ready", `{"status":"ok","data":{"commit":"abc","components":{"sunshine":{"status":"running","pid":1},"web_server":{"status":"running","pid":2}}}}`, 200, true},
		{"foreign build", `{"status":"ok","data":{"commit":"other"}}`, 200, false},
		{"empty components", `{"status":"ok","data":{"commit":"abc"}}`, 200, false},
		{"failed child", `{"status":"ok","data":{"commit":"abc","components":{"sunshine":{"status":"error","pid":0},"web_server":{"status":"running","pid":2}}}}`, 200, false},
		{"missing process", `{"status":"ok","data":{"commit":"abc","components":{"sunshine":{"status":"running","pid":0},"web_server":{"status":"running","pid":2}}}}`, 200, false},
		{"invalid json", `{}`, 200, false},
		{"trailing data", `{} {}`, 200, false},
		{"http failure", `{}`, 503, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := &http.Response{StatusCode: test.code, Body: http.NoBody}
			response.Body = io.NopCloser(strings.NewReader(test.body))
			defer response.Body.Close()
			if got := inspectReady(response, cfg, "abc") == ""; got != test.ready {
				t.Fatalf("readiness = %v", got)
			}
		})
	}
}

func TestReadinessPollsAndHonorsCancellation(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/health" {
			t.Error("unexpected endpoint")
		}
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		fmt.Fprint(w, `{"status":"ok","data":{"commit":"abc"}}`)
	}))
	defer server.Close()
	cfg := &config.Config{Server: config.ServerConfig{BindAddress: strings.TrimPrefix(server.URL, "http://")}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := WaitReady(ctx, cfg, "abc"); err != nil {
		t.Fatal(err)
	}
	cancel()
	if WaitReady(ctx, cfg, "abc") == nil {
		t.Fatal("ignored canceled deadline")
	}
}

func TestReadinessVerifiesConfiguredTLSCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"status":"ok","data":{"commit":"abc"}}`) }))
	defer server.Close()
	folder := t.TempDir()
	certFile, keyFile := filepath.Join(folder, "cert.pem"), filepath.Join(folder, "key.pem")
	cert := server.TLS.Certificates[0]
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Server: config.ServerConfig{BindAddress: strings.TrimPrefix(server.URL, "https://"), TLSCert: certFile, TLSKey: keyFile}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := WaitReady(ctx, cfg, "abc"); err != nil {
		t.Fatal(err)
	}
}

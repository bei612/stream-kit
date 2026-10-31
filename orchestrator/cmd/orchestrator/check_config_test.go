package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestCheckConfigReadOnly(t *testing.T) {
	oldBase := config.BaseDir
	t.Cleanup(func() { config.BaseDir = oldBase })
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := checkConfig(path); err == nil {
		t.Fatal("missing configuration accepted")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatal("preflight created files", err)
	}
	cfg := config.Config{Server: config.ServerConfig{BindAddress: "127.0.0.1:9000", Username: "test", Password: "private-password"}, Storage: config.StorageConfig{AppsDir: "apps", TempDir: "temp", DBPath: "data/control.db", MaxUploadSize: 1024, MaxExtractSize: 1024, MaxFileCount: 10}, Process: config.ProcessConfig{MonitorInterval: 1}}
	write := func() []byte {
		t.Helper()
		data, err := json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		return data
	}
	original := write()
	if err := checkConfig(path); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != string(original) {
		t.Fatal("configuration changed", err)
	}
	entries, err = os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatal("preflight initialized runtime storage", err)
	}
	t.Run("deployment overlay", func(t *testing.T) {
		t.Setenv("ORCH_SERVER_BIND_ADDRESS", "private-invalid-address")
		err := checkConfig(path)
		if err == nil || strings.Contains(err.Error(), "private-") {
			t.Fatal("invalid overlay accepted or disclosed", err)
		}
	})
	cfg.Server.TLSCert, cfg.Server.TLSKey = "missing-cert.pem", "missing-key.pem"
	write()
	if err := checkConfig(path); err == nil || !strings.Contains(err.Error(), "TLS key pair") {
		t.Fatal("unreadable TLS pair accepted", err)
	}
	// Hold the configured socket to distinguish TLS-first validation from an
	// unrelated bind failure. Invalid credentials must never initialize storage.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg.Server.BindAddress = listener.Addr().String()
	write()
	oldArgs := os.Args
	os.Args = []string{"orchestrator", "--config", path}
	t.Cleanup(func() { os.Args = oldArgs })
	ready := false
	if err := run(context.Background(), func() { ready = true }); err == nil || !strings.Contains(err.Error(), "TLS key pair") {
		t.Fatal("startup did not validate TLS before binding", err)
	}
	if ready {
		t.Fatal("invalid TLS announced readiness")
	}
	entries, err = os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatal("invalid TLS initialized runtime storage", err)
	}
}

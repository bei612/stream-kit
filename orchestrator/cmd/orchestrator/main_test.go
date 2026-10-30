package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestRuntimeCancellationClosesHTTPAndDatabase(t *testing.T) {
	t.Run("HTTP", func(t *testing.T) { testRuntimeCancellation(t, false, false) })
	t.Run("HTTPS", func(t *testing.T) { testRuntimeCancellation(t, true, false) })
	t.Run("active encoder monitor", func(t *testing.T) { testRuntimeCancellation(t, false, true) })
}

func testRuntimeCancellation(t *testing.T, encrypted, monitor bool) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := config.Config{Server: config.ServerConfig{BindAddress: address, Username: "test", Password: "test-password", JWTSecret: strings.Repeat("x", 32)}, Components: map[string]config.ComponentConfig{}, Storage: config.StorageConfig{AppsDir: "apps", TempDir: "temp", DBPath: "control.db", MaxUploadSize: 1024, MaxExtractSize: 1024, MaxFileCount: 10}, Process: config.ProcessConfig{MonitorInterval: 1, GracefulShutdownTimeout: 1}}
	entered, cancelled := make(chan struct{}, 1), make(chan struct{}, 1)
	if monitor {
		encoder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/stream-kit/capabilities" {
				_, _ = w.Write([]byte(`{"schema_version":1,"capture_modes":["desktop"],"capture_mode_apply":"application_restart","managed_runtime_version":1}`))
				return
			}
			if r.URL.Path != "/api/stream-kit/runtime" {
				http.NotFound(w, r)
				return
			}
			select {
			case entered <- struct{}{}:
			default:
			}
			<-r.Context().Done()
			select {
			case cancelled <- struct{}{}:
			default:
			}
		}))
		defer encoder.Close()
		cfg.SunshineAPI.BaseURL = encoder.URL
	}
	scheme := "http"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	if encrypted {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		keyDER, err := x509.MarshalECPrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		cfg.Server.TLSCert = filepath.Join(dir, "certificate.pem")
		cfg.Server.TLSKey = filepath.Join(dir, "key.pem")
		if err := os.WriteFile(cfg.Server.TLSCert, certPEM, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cfg.Server.TLSKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
			t.Fatal(err)
		}
		roots := x509.NewCertPool()
		roots.AppendCertsFromPEM(certPEM)
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
		scheme = "https"
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	oldArgs, oldBase := os.Args, config.BaseDir
	os.Args = []string{"orchestrator", "--config", path}
	defer func() { os.Args = oldArgs; config.BaseDir = oldBase }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- run(ctx, func() { close(ready) }) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("startup failed: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("startup timed out")
	}
	client := &http.Client{Timeout: time.Second, Transport: transport}
	response, err := client.Get(scheme + "://" + address + "/api/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("health status %d", response.StatusCode)
	}
	if monitor {
		select {
		case <-entered:
		case <-time.After(10 * time.Second):
			t.Fatal("encoder monitor did not start")
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown timed out")
	}
	if monitor {
		select {
		case <-cancelled:
		case <-time.After(time.Second):
			t.Fatal("encoder observation survived cancellation")
		}
	}
	if response, err := client.Get(scheme + "://" + address + "/api/v1/health"); err == nil {
		response.Body.Close()
		t.Fatal("listener survived shutdown")
	}
	// Windows refuses this move if SQLite resources remain open.
	if err := os.Rename(filepath.Join(dir, "control.db"), filepath.Join(dir, "closed.db")); err != nil {
		t.Fatalf("database still held: %v", err)
	}
}

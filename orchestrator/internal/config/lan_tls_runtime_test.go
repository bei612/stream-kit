package config

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestManagedTLSHotReloadRetainsListenerAndTrust(t *testing.T) {
	cfg, roots := lanFixture(t)
	m, err := NewManagedTLS(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ca, key := fileDigest(t, cfg.LANTLS.CACert), fileDigest(t, cfg.TLSKey)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }), TLSConfig: m.TLSConfig()}
	done := make(chan struct{})
	go func() { defer close(done); _ = s.ServeTLS(listener, "", "") }()
	defer func() { s.Close(); <-done }()
	address := listener.Addr().String()
	connect := func(host string) *tls.Conn {
		t.Helper()
		c, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", address, &tls.Config{RootCAs: roots, ServerName: host, MinVersion: tls.VersionTLS12})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	old := connect("192.168.3.66")
	defer old.Close()
	m.cfg.LANTLS.Hosts = []string{"127.0.0.1", "192.168.8.88"}
	if changed, err := m.Refresh(); err != nil || !changed {
		t.Fatal(changed, err)
	}
	newConn := connect("192.168.8.88")
	newConn.Close()
	if m.certificate.Load().Leaf.VerifyHostname("192.168.3.66") == nil {
		t.Fatal("retired identity retained")
	}
	// Existing TLS connections are not closed by certificate rotation.
	old.SetDeadline(time.Now().Add(time.Second))
	if _, err := old.Write([]byte("GET / HTTP/1.1\r\nHost: old\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	var response [128]byte
	if n, err := old.Read(response[:]); err != nil || n == 0 {
		t.Fatal("existing connection interrupted", err)
	}
	if ca != fileDigest(t, cfg.LANTLS.CACert) || key != fileDigest(t, cfg.TLSKey) {
		t.Fatal("trust or key replaced")
	}
	if changed, err := m.Refresh(); err != nil || changed {
		t.Fatal("unnecessary reissue", changed, err)
	}
	before := m.certificate.Load()
	if err := os.WriteFile(cfg.LANTLS.CAKey, []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Refresh(); err == nil {
		t.Fatal("invalid issuer accepted")
	}
	if before != m.certificate.Load() {
		t.Fatal("failed refresh replaced working identity")
	}
	connect("192.168.8.88").Close()
}

func TestManagedTLSWorkerStopsWithOwner(t *testing.T) {
	cfg, _ := lanFixture(t)
	m, err := NewManagedTLS(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx, func(bool, error) {}); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("TLS worker leaked after cancellation")
	}
}

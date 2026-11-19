package config

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"sync"
	"sync/atomic"
	"time"
)

// ManagedTLS owns a single refresh loop and one currently validated leaf.
// GetCertificate only reads memory; handshakes never do filesystem I/O or sign.
type ManagedTLS struct {
	cfg         ServerConfig
	mu          sync.Mutex
	certificate atomic.Pointer[tls.Certificate]
}

func NewManagedTLS(cfg ServerConfig) (*ManagedTLS, error) {
	m := &ManagedTLS{cfg: cfg}
	if _, err := m.Refresh(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *ManagedTLS) TLSConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return m.certificate.Load(), nil
	}}
}

func (m *ManagedTLS) Refresh() (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := PrepareManagedTLS(m.cfg); err != nil {
		return false, err
	}
	pair, err := tls.LoadX509KeyPair(m.cfg.TLSCert, m.cfg.TLSKey)
	if err != nil {
		return false, err
	}
	previous := m.certificate.Load()
	if previous != nil && sha256.Sum256(previous.Certificate[0]) == sha256.Sum256(pair.Certificate[0]) {
		return false, nil
	}
	m.certificate.Store(&pair)
	return true, nil
}

func (m *ManagedTLS) Run(ctx context.Context, report func(changed bool, err error)) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	failed := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			changed, err := m.Refresh()
			// Report failure/recovery transitions only; outages must not create
			// an unbounded stream of identical log records.
			if changed || (err != nil) != failed {
				report(changed, err)
			}
			failed = err != nil
		}
	}
}

package main

import (
	"crypto/tls"
	"fmt"

	"github.com/stream-kit/orchestrator/internal/config"
)

// checkConfig deliberately does not initialize storage, bind sockets, or start
// components. Deployment tools can call it before changing service registration.
func checkConfig(path string) error {
	cfg, err := config.LoadExisting(path)
	if err != nil {
		return err
	}
	_, err = serverTLS(cfg.Server)
	return err
}

// Load once before any runtime initialization, using the same path for preflight
// and actual startup. ServeTLS reuses this certificate instead of reopening it.
func serverTLS(cfg config.ServerConfig) (*tls.Config, error) {
	if cfg.TLSCert == "" && cfg.TLSKey == "" {
		return nil, nil
	}
	certificate, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		return nil, fmt.Errorf("load configured TLS key pair: %w", err)
	}
	return &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}, nil
}

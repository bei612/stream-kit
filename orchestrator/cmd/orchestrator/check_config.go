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
	if cfg.Server.TLSCert != "" {
		if _, err := tls.LoadX509KeyPair(cfg.Server.TLSCert, cfg.Server.TLSKey); err != nil {
			return fmt.Errorf("load configured TLS key pair: %w", err)
		}
	}
	return nil
}

package deployment

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
)

// WaitReady checks the owned control instance and its configured autostart
// components. SCM Running alone only proves that the control listener started.
func WaitReady(ctx context.Context, cfg *config.Config, commit string) error {
	host, port, err := net.SplitHostPort(cfg.Server.BindAddress)
	if err != nil {
		return fmt.Errorf("invalid control listener")
	}
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if host == "::" {
		host = "::1"
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	scheme := "http"
	if cfg.Server.TLSCert != "" {
		scheme = "https"
		pem, err := os.ReadFile(cfg.Server.TLSCert)
		if err != nil {
			return fmt.Errorf("read configured readiness certificate: %w", err)
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			return fmt.Errorf("invalid readiness certificate")
		}
		pair, err := tls.LoadX509KeyPair(cfg.Server.TLSCert, cfg.Server.TLSKey)
		if err != nil {
			return fmt.Errorf("load readiness TLS identity: %w", err)
		}
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return err
		}
		name := host
		// Connect to the local listener while verifying its configured identity.
		if len(leaf.DNSNames) > 0 {
			name = leaf.DNSNames[0]
		} else if len(leaf.IPAddresses) > 0 {
			name = leaf.IPAddresses[0].String()
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: name, MinVersion: tls.VersionTLS12}
	}
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	endpoint := scheme + "://" + net.JoinHostPort(host, port) + "/api/v1/health"
	last := "control endpoint unavailable"
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("platform not ready: %s: %w", last, err)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err == nil {
			last = inspectReady(response, cfg, commit)
			response.Body.Close()
			if last == "" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("platform not ready: %s: %w", last, ctx.Err())
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func inspectReady(response *http.Response, cfg *config.Config, commit string) string {
	if response.StatusCode != http.StatusOK {
		return "control health request failed"
	}
	var report struct {
		Status string `json:"status"`
		Data   struct {
			Commit     string `json:"commit"`
			Components map[string]struct {
				Status string `json:"status"`
				PID    int    `json:"pid"`
			} `json:"components"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 65537))
	if decoder.Decode(&report) != nil || decoder.Decode(new(any)) != io.EOF {
		return "invalid control health response"
	}
	if report.Status != "ok" || report.Data.Commit != commit {
		return "control health identity mismatch"
	}
	var pending []string
	for name, component := range cfg.Components {
		if !component.AutoStart {
			continue
		}
		actual, exists := report.Data.Components[name]
		if !exists || actual.Status != "running" || (component.ExePath != "" && actual.PID <= 0) {
			pending = append(pending, name)
		}
	}
	sort.Strings(pending)
	if len(pending) > 0 {
		return "components pending: " + strings.Join(pending, ", ")
	}
	return ""
}

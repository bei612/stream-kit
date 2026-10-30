package component

import (
	"context"
	"crypto/tls"
	"net/http"
	"sync"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

type HealthChecker struct {
	cfg              config.HealthCheckConfig
	logger           *zap.Logger
	name             string
	client           *http.Client
	mu               sync.Mutex
	consecutiveFails int
	consecutiveOK    int
	ctx              context.Context
	cancel           context.CancelFunc
}

func NewHealthChecker(name string, cfg config.HealthCheckConfig, logger *zap.Logger) *HealthChecker {
	ctx, cancel := context.WithCancel(context.Background())
	timeout := time.Duration(cfg.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	transport := &http.Transport{}
	if cfg.VerifySSL != nil && !*cfg.VerifySSL {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &HealthChecker{
		ctx:    ctx,
		cancel: cancel,
		cfg:    cfg,
		logger: logger,
		name:   name,
		client: &http.Client{
			Timeout:   timeout,
			Transport: transport,
		},
	}
}

func (hc *HealthChecker) Check() bool {
	if hc.cfg.URL == "" {
		hc.recordOK()
		return true
	}

	req, err := http.NewRequestWithContext(hc.ctx, http.MethodGet, hc.cfg.URL, nil)
	if err != nil {
		hc.recordFail()
		return false
	}

	resp, err := hc.client.Do(req)
	if err != nil {
		hc.recordFail()
		return false
	}
	resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		hc.recordOK()
		return true
	}

	hc.recordFail()
	return false
}

func (hc *HealthChecker) recordFail() {
	hc.mu.Lock()
	hc.consecutiveFails++
	hc.consecutiveOK = 0
	hc.mu.Unlock()
}

func (hc *HealthChecker) recordOK() {
	hc.mu.Lock()
	hc.consecutiveOK++
	hc.consecutiveFails = 0
	hc.mu.Unlock()
}

func (hc *HealthChecker) IsUnhealthy() bool {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	threshold := hc.cfg.UnhealthyThreshold
	if threshold <= 0 {
		threshold = 3
	}
	return hc.consecutiveFails >= threshold
}

func (hc *HealthChecker) IsHealthy() bool {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	threshold := hc.cfg.HealthyThreshold
	if threshold <= 0 {
		threshold = 1
	}
	return hc.consecutiveOK >= threshold
}

func (hc *HealthChecker) IntervalDuration() time.Duration {
	sec := hc.cfg.IntervalSeconds
	if sec <= 0 {
		sec = 10
	}
	return time.Duration(sec) * time.Second
}

// Close releases idle HTTP connections held by the transport.
func (hc *HealthChecker) Close() {
	hc.cancel()
	if t, ok := hc.client.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
}

func (hc *HealthChecker) StartupTimeout() time.Duration {
	sec := hc.cfg.StartupTimeoutSeconds
	if sec <= 0 {
		sec = 60
	}
	return time.Duration(sec) * time.Second
}

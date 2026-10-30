// Package mediacontrol owns the versioned control-plane/media-plane contract.
// Signed full snapshots converge after missed updates; short leases fail closed
// when the control plane is unavailable. Browser input never writes this state.
package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/stream-kit/orchestrator/internal/session"
	"go.uber.org/zap"
)

const SigningContext = "stream-kit/media-state/v1\n"

type Connection struct {
	ID        string `json:"connection_id"`
	ExpiresAt int64  `json:"expires_at_ms"`
}
type Session struct {
	ID           string              `json:"session_id"`
	Revision     uint64              `json:"revision"`
	HostID       int64               `json:"host_id"`
	AppID        int64               `json:"app_id"`
	ControllerID string              `json:"controller_connection_id"`
	Connections  []Connection        `json:"connections"`
	Audio        session.AudioConfig `json:"audio"`
}
type Envelope struct {
	SchemaVersion int       `json:"schema_version"`
	IssuedAt      int64     `json:"issued_at_ms"`
	ExpiresAt     int64     `json:"expires_at_ms"`
	Sessions      []Session `json:"sessions"`
}
type Publisher struct {
	mu         sync.Mutex
	manager    *session.Manager
	endpoint   string
	secret     []byte
	client     *http.Client
	lastIssued int64
	status     Status
}

type Status struct {
	Reachable             bool                          `json:"reachable"`
	LeaseValid            bool                          `json:"lease_valid"`
	AcknowledgedAt        int64                         `json:"acknowledged_at_ms"`
	LeaseExpiresAt        int64                         `json:"lease_expires_at_ms"`
	Revisions             map[string]uint64             `json:"applied_revisions"`
	ObservedAt            int64                         `json:"observed_at_ms"`
	ObservationsValid     bool                          `json:"observations_valid"`
	ObservationsExpiresAt int64                         `json:"observations_expires_at_ms"`
	Observations          map[string]SessionObservation `json:"observations"`
}

func (p *Publisher) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.status
	now := time.Now().UnixMilli()
	s.LeaseValid = now < s.LeaseExpiresAt
	s.ObservationsExpiresAt = min(s.LeaseExpiresAt, s.AcknowledgedAt+observationFreshnessMS)
	s.ObservationsValid = s.Reachable && s.LeaseValid && now >= s.AcknowledgedAt && now < s.ObservationsExpiresAt
	s.Observations = make(map[string]SessionObservation, len(p.status.Observations))
	for id, observation := range p.status.Observations {
		s.Observations[id] = cloneObservation(observation)
	}
	s.Revisions = make(map[string]uint64, len(p.status.Revisions))
	for id, rev := range p.status.Revisions {
		s.Revisions[id] = rev
	}
	return s
}

func New(manager *session.Manager, baseURL, secret string) *Publisher {
	if manager == nil || baseURL == "" || secret == "" {
		return nil
	}
	return &Publisher{manager: manager, endpoint: strings.TrimRight(baseURL, "/") + "/internal/v1/media-state", secret: []byte(secret), client: &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (p *Publisher) Sync(ctx context.Context) (err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	defer func() { p.status.Reachable = err == nil }()
	now := time.Now().UnixMilli()
	if now <= p.lastIssued {
		now = p.lastIssued + 1
	}
	p.lastIssued = now
	envelope := Envelope{SchemaVersion: 1, IssuedAt: now, ExpiresAt: now + 10000, Sessions: []Session{}}
	for _, s := range p.manager.List() {
		if s.State == session.StateStopped || s.State == session.StateStopping {
			continue
		}
		item := Session{ID: s.ID, Revision: s.Revision, HostID: s.HostID, AppID: s.AppID, ControllerID: s.ControllerConnectionID, Audio: s.Audio, Connections: []Connection{}}
		for _, c := range s.Connections {
			if c.ExpiresAt.UnixMilli() > now {
				item.Connections = append(item.Connections, Connection{ID: c.ID, ExpiresAt: c.ExpiresAt.UnixMilli()})
			}
		}
		if controller, ok := s.Connections[item.ControllerID]; !ok || controller.ExpiresAt.UnixMilli() <= now {
			item.ControllerID = ""
		}
		envelope.Sessions = append(envelope.Sessions, item)
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, p.secret)
	mac.Write([]byte(SigningContext))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Stream-State-Signature", hex.EncodeToString(mac.Sum(nil)))
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("media state rejected: HTTP %d", resp.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, observationMaxBytes+1))
	if err != nil {
		return err
	}
	ack, err := decodeAcknowledgement(p.secret, resp.Header.Get("X-Stream-Observation-Signature"), responseBody, envelope, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	p.status.AcknowledgedAt = time.Now().UnixMilli()
	p.status.LeaseExpiresAt = envelope.ExpiresAt
	p.status.ObservedAt = ack.ObservedAt
	p.status.Observations = make(map[string]SessionObservation, len(ack.Sessions))
	for _, observation := range ack.Sessions {
		p.status.Observations[observation.SessionID] = observation
	}
	p.status.Revisions = make(map[string]uint64, len(envelope.Sessions))
	for _, s := range envelope.Sessions {
		p.status.Revisions[s.ID] = s.Revision
	}
	return nil
}
func (p *Publisher) Run(ctx context.Context, logger *zap.Logger) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := p.Sync(ctx); err != nil && ctx.Err() == nil {
			logger.Warn("media state reconciliation failed", zap.Error(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-p.manager.Changes():
		}
	}
}

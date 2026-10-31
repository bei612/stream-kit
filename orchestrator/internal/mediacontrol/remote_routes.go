package mediacontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/session"
	"go.uber.org/zap"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type microphoneRoute struct {
	SchemaVersion int                        `json:"schema_version"`
	IssuedAt      int64                      `json:"issued_at_ms"`
	ExpiresAt     int64                      `json:"expires_at_ms"`
	Binding       identity.MicrophoneBinding `json:"binding"`
	URL           string                     `json:"url"`
	Token         string                     `json:"token"`
}

func (p *NodeClient) applyMicrophoneRoute(ctx context.Context, route microphoneRoute) error {
	const requestDomain = "stream-kit/node-microphone-route/request/v1\n"
	const responseDomain = "stream-kit/node-microphone-route/response/v1\n"
	body, err := json.Marshal(route)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.baseURL+"/internal/v1/node-microphone-route", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(controlSignatureHeader, controlSignature(p.secret, requestDomain, body))
	response, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("source microphone connection unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("source microphone route rejected: HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return fmt.Errorf("invalid source microphone response")
	}
	got, err := hex.DecodeString(response.Header.Get(controlSignatureHeader))
	want, _ := hex.DecodeString(controlSignature(p.secret, responseDomain, raw))
	if err != nil || !hmac.Equal(got, want) {
		return fmt.Errorf("unauthenticated source microphone response")
	}
	var ack struct {
		SchemaVersion int    `json:"schema_version"`
		IssuedAt      int64  `json:"issued_at_ms"`
		InstanceID    string `json:"target_instance_id"`
		SessionID     string `json:"session_id"`
		TargetEpoch   uint64 `json:"target_epoch"`
		ControlEpoch  uint64 `json:"control_epoch"`
		Connected     bool   `json:"connected"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&ack) != nil || decoder.Decode(new(any)) != io.EOF || ack.SchemaVersion != 1 || ack.IssuedAt != route.IssuedAt || ack.InstanceID != route.Binding.TargetInstanceID || ack.SessionID != route.Binding.SessionID || ack.TargetEpoch != route.Binding.TargetEpoch || ack.ControlEpoch != route.Binding.ControlEpoch || !ack.Connected || time.Now().UnixMilli() >= route.ExpiresAt {
		return fmt.Errorf("mismatched source microphone response")
	}
	return nil
}

// Separate from media-state renewal: an offline target never blocks audience
// audio, controller lease publication or another node's control connection.
func (p *Publisher) RunRoutes(ctx context.Context, logger *zap.Logger) {
	var workers sync.WaitGroup
	for nodeID, client := range p.nodes {
		workers.Add(1)
		go func(nodeID string, client *NodeClient) {
			defer workers.Done()
			instances := map[string]string{}
			previous := false
			var lastIssued int64
			lastError := ""
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				sessions := []*session.RenderSession{}
				for _, s := range p.manager.List() {
					if s.Audio.Target.Mode == "remote" && s.Audio.Target.NodeID == nodeID && s.State != session.StateStopped && s.State != session.StateStopping {
						sessions = append(sessions, s)
					}
				}
				if len(sessions) > 0 || previous {
					now := time.Now().UnixMilli()
					if now <= lastIssued {
						now = lastIssued + 1
					}
					lastIssued = now
					if len(sessions) > 0 {
						previous = true
					}
					err := p.reconcileNodeRoutes(ctx, nodeID, client, sessions, instances, now)
					p.setRouteError(nodeID, err)
					if err != nil {
						if ctx.Err() == nil && err.Error() != lastError {
							logger.Warn("microphone target route unavailable", zap.String("node_id", nodeID), zap.Error(err))
							lastError = err.Error()
						}
					} else {
						previous = len(sessions) > 0
						lastError = ""
					}
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}(nodeID, client)
	}
	workers.Wait()
}

func (p *Publisher) reconcileNodeRoutes(ctx context.Context, nodeID string, client *NodeClient, sessions []*session.RenderSession, instances map[string]string, now int64) error {
	if instances[nodeID] == "" {
		inventory, err := client.AudioDevices(ctx)
		if err != nil {
			return err
		}
		instances[nodeID] = inventory.InstanceID
	}
	state := NodeAudioState{SchemaVersion: 1, NodeID: nodeID, InstanceID: instances[nodeID], State: Envelope{SchemaVersion: 3, IssuedAt: now, ExpiresAt: now + 10000, Sessions: []Session{}}, Bindings: []identity.MicrophoneBinding{}}
	status := p.Status()
	for _, s := range sessions {
		item := Session{ID: s.ID, ControlEpoch: s.ControlEpoch, Revision: s.Revision, HostID: s.HostID, AppID: s.AppID, ControllerID: s.ControllerConnectionID, Audio: projectAudio(s.Audio), Connections: []Connection{}}
		item.Audio.Target.Mode = "local"
		item.Audio.Target.NodeID = ""
		for _, c := range s.Connections {
			if c.ExpiresAt.UnixMilli() > now {
				item.Connections = append(item.Connections, Connection{ID: c.ID, ExpiresAt: c.ExpiresAt.UnixMilli()})
			}
		}
		controller := s.Connections[item.ControllerID]
		if controller == nil || controller.ExpiresAt.UnixMilli() <= now {
			item.ControllerID = ""
		}
		state.State.Sessions = append(state.State.Sessions, item)
		observation := status.Observations[s.ID]
		if item.ControllerID != "" && item.Audio.MicrophoneEnabled && status.ObservationsValid && status.Revisions[s.ID] == s.Revision && observation.UpstreamActive {
			state.Bindings = append(state.Bindings, identity.MicrophoneBinding{SourceNodeID: "primary", TargetNodeID: nodeID, TargetInstanceID: state.InstanceID, SessionID: s.ID, ConnectionID: item.ControllerID, HostID: uint32(s.HostID), AppID: uint32(s.AppID), TargetEpoch: s.Audio.Target.Epoch, ControlEpoch: s.ControlEpoch})
		}
	}
	if _, err := client.ApplyNodeAudioState(ctx, state); err != nil {
		delete(instances, nodeID)
		return err
	}
	var routeError error
	for _, binding := range state.Bindings {
		token, err := identity.IssueMicrophone(binding, client.secret, time.Now())
		if err != nil {
			return err
		}
		address, err := url.Parse(client.baseURL)
		if err != nil {
			return err
		}
		if address.Scheme == "https" {
			address.Scheme = "wss"
		} else {
			address.Scheme = "ws"
		}
		address.Path = strings.TrimRight(address.Path, "/") + "/internal/v1/node-microphone/" + binding.SessionID
		if err = p.NodeClient.applyMicrophoneRoute(ctx, microphoneRoute{1, now, now + 10000, binding, address.String(), token}); err != nil {
			if routeError == nil {
				routeError = err
			}
		}
	}
	return routeError
}

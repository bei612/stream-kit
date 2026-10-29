package session

import (
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/ws"
)

var ErrNotFound = errors.New("stream session or connection not found")
var ErrControllerExists = errors.New("stream session already has a controller")

type AudioConfig struct {
	ProgramGainDB          float64 `json:"program_gain_db"`
	MicrophoneGainDB       float64 `json:"microphone_gain_db"`
	MicrophoneEnabled      bool    `json:"microphone_enabled"`
	BroadcastControllerMic bool    `json:"broadcast_controller_microphone"`
	ControllerMonitor      bool    `json:"controller_monitor"`
}

type Policy struct {
	ControllerDisconnectPolicy string `json:"controller_disconnect_policy"`
	MaxViewers                 int    `json:"max_viewers"`
	AllowViewerMicrophone      bool   `json:"allow_viewer_microphone"`
}

type Connection struct {
	ID              string    `json:"connection_id"`
	UserID          string    `json:"user_id,omitempty"`
	Role            string    `json:"role"`
	State           string    `json:"state"`
	Microphone      bool      `json:"microphone"`
	MicrophoneLive  bool      `json:"microphone_live"`
	ConnectedAt     time.Time `json:"connected_at"`
	LastHeartbeatAt time.Time `json:"last_heartbeat_at"`
}

type RenderSession struct {
	ID                     string                 `json:"session_id"`
	HostID                 int64                  `json:"host_id"`
	AppID                  int64                  `json:"app_id"`
	State                  string                 `json:"state"`
	ControllerConnectionID string                 `json:"controller_connection_id,omitempty"`
	Audio                  AudioConfig            `json:"audio"`
	Policy                 Policy                 `json:"policy"`
	Connections            map[string]*Connection `json:"connections"`
	CreatedAt              time.Time              `json:"created_at"`
	UpdatedAt              time.Time              `json:"updated_at"`
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*RenderSession
	hub      *ws.Hub
}

func NewManager(hub *ws.Hub) *Manager {
	return &Manager{sessions: make(map[string]*RenderSession), hub: hub}
}

func (m *Manager) List() []*RenderSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*RenderSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, clone(s))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (m *Manager) Get(id string) (*RenderSession, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return clone(s), nil
}

func (m *Manager) Ensure(hostID, appID int64) *RenderSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.HostID == hostID && s.AppID == appID && s.State != "stopped" {
			return clone(s)
		}
	}
	now := time.Now().UTC()
	s := &RenderSession{ID: uuid.NewString(), HostID: hostID, AppID: appID, State: "viewing", Audio: AudioConfig{MicrophoneEnabled: true, BroadcastControllerMic: true}, Policy: Policy{ControllerDisconnectPolicy: "manual", MaxViewers: 20}, Connections: map[string]*Connection{}, CreatedAt: now, UpdatedAt: now}
	m.sessions[s.ID] = s
	m.emit("stream_session_created", s)
	return clone(s)
}

func (m *Manager) AddConnection(sessionID, userID string) (*Connection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return nil, ErrNotFound
	}
	if s.Policy.MaxViewers > 0 && len(s.Connections) >= s.Policy.MaxViewers {
		return nil, errors.New("viewer limit reached")
	}
	now := time.Now().UTC()
	c := &Connection{ID: uuid.NewString(), UserID: userID, Role: "viewer", State: "connected", ConnectedAt: now, LastHeartbeatAt: now, Microphone: false}
	s.Connections[c.ID] = c
	s.UpdatedAt = now
	m.emit("stream_connection_changed", s)
	return copyConnection(c), nil
}

func (m *Manager) Claim(sessionID, connectionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	if _, ok = s.Connections[connectionID]; !ok {
		return ErrNotFound
	}
	if s.ControllerConnectionID != "" && s.ControllerConnectionID != connectionID {
		return ErrControllerExists
	}
	for _, c := range s.Connections {
		c.Role = "viewer"
	}
	s.Connections[connectionID].Role = "controller"
	s.ControllerConnectionID = connectionID
	s.UpdatedAt = time.Now().UTC()
	m.emit("stream_controller_changed", s)
	return nil
}

func (m *Manager) Release(sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	for _, c := range s.Connections {
		c.Role = "viewer"
	}
	s.ControllerConnectionID = ""
	s.UpdatedAt = time.Now().UTC()
	m.emit("stream_controller_changed", s)
	return nil
}

func (m *Manager) UpdateAudio(sessionID string, cfg AudioConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	s.Audio = cfg
	s.UpdatedAt = time.Now().UTC()
	m.emit("stream_audio_changed", s)
	return nil
}
func (m *Manager) UpdatePolicy(sessionID string, p Policy) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	s.Policy = p
	s.UpdatedAt = time.Now().UTC()
	m.emit("stream_policy_changed", s)
	return nil
}

func (m *Manager) Disconnect(sessionID, connectionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	if _, ok := s.Connections[connectionID]; !ok {
		return ErrNotFound
	}
	delete(s.Connections, connectionID)
	if s.ControllerConnectionID == connectionID {
		s.ControllerConnectionID = ""
	}
	s.UpdatedAt = time.Now().UTC()
	m.emit("stream_connection_changed", s)
	return nil
}

func (m *Manager) Heartbeat(sessionID, connectionID string, microphone, live bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return ErrNotFound
	}
	c, ok := s.Connections[connectionID]
	if !ok {
		return ErrNotFound
	}
	c.LastHeartbeatAt = time.Now().UTC()
	c.Microphone = microphone
	c.MicrophoneLive = live
	s.UpdatedAt = c.LastHeartbeatAt
	m.emit("stream_connection_changed", s)
	return nil
}

func (m *Manager) emit(typ string, s *RenderSession) {
	if m.hub != nil {
		m.hub.Broadcast(ws.Event{Type: typ, Data: clone(s)})
	}
}
func clone(s *RenderSession) *RenderSession {
	if s == nil {
		return nil
	}
	x := *s
	x.Connections = make(map[string]*Connection, len(s.Connections))
	for id, c := range s.Connections {
		x.Connections[id] = copyConnection(c)
	}
	return &x
}
func copyConnection(c *Connection) *Connection {
	if c == nil {
		return nil
	}
	x := *c
	return &x
}

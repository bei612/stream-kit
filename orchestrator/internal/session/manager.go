package session

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/ws"
)

var ErrNotFound = errors.New("stream session or connection not found")
var ErrControllerExists = errors.New("stream session already has a controller")
var ErrInvalidState = errors.New("invalid stream session state")

const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateDegraded = "degraded"
	StateStopping = "stopping"
	StateStopped  = "stopped"
)

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
	ExpiresAt       time.Time `json:"expires_at"`
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
	store    *store.Store
}

func NewManager(hub *ws.Hub) *Manager {
	return &Manager{sessions: make(map[string]*RenderSession), hub: hub}
}

func NewManagerWithStore(hub *ws.Hub, st *store.Store) (*Manager, error) {
	m := &Manager{sessions: make(map[string]*RenderSession), hub: hub, store: st}
	if st == nil {
		return m, nil
	}
	records, err := st.ListStreamSessions()
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		s, err := fromRecord(record)
		if err != nil {
			return nil, err
		}
		m.sessions[s.ID] = s
	}
	return m, nil
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
	for _, s := range m.sessions {
		if s.HostID == hostID && s.AppID == appID && s.State != "stopped" {
			result := clone(s)
			m.mu.Unlock()
			return result
		}
	}
	now := time.Now().UTC()
	s := &RenderSession{ID: uuid.NewString(), HostID: hostID, AppID: appID, State: StateStarting, Audio: AudioConfig{MicrophoneEnabled: true, BroadcastControllerMic: true}, Policy: Policy{ControllerDisconnectPolicy: "release", MaxViewers: 20}, Connections: map[string]*Connection{}, CreatedAt: now, UpdatedAt: now}
	m.sessions[s.ID] = s
	result := clone(s)
	m.mu.Unlock()
	m.emit("stream_session_created", result)
	m.persist(result)
	return result
}

// SetState changes the media lifecycle state. It is intentionally explicit so
// the media gateway and control plane cannot silently disagree about whether a
// session is usable.
func (m *Manager) SetState(sessionID, state string) error {
	if state != StateStarting && state != StateRunning && state != StateDegraded && state != StateStopping && state != StateStopped {
		return ErrInvalidState
	}
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	s.State = state
	s.UpdatedAt = time.Now().UTC()
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_session_state_changed", snapshot)
	m.persist(snapshot)
	return nil
}

func (m *Manager) AddConnection(sessionID, userID string) (*Connection, error) {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return nil, ErrNotFound
	}
	if s.Policy.MaxViewers > 0 && len(s.Connections) >= s.Policy.MaxViewers {
		return nil, errors.New("viewer limit reached")
	}
	now := time.Now().UTC()
	c := &Connection{ID: uuid.NewString(), UserID: userID, Role: "viewer", State: "connected", ConnectedAt: now, LastHeartbeatAt: now, ExpiresAt: now.Add(15 * time.Second), Microphone: false}
	s.Connections[c.ID] = c
	s.UpdatedAt = now
	result := copyConnection(c)
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_connection_changed", snapshot)
	m.persist(snapshot)
	return result, nil
}

func (m *Manager) Claim(sessionID, connectionID string) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	if _, ok = s.Connections[connectionID]; !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	if s.ControllerConnectionID != "" && s.ControllerConnectionID != connectionID {
		m.mu.Unlock()
		return ErrControllerExists
	}
	for _, c := range s.Connections {
		c.Role = "viewer"
	}
	s.Connections[connectionID].Role = "controller"
	s.ControllerConnectionID = connectionID
	s.UpdatedAt = time.Now().UTC()
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_controller_changed", snapshot)
	m.persist(snapshot)
	return nil
}

func (m *Manager) Release(sessionID string) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	for _, c := range s.Connections {
		c.Role = "viewer"
	}
	s.ControllerConnectionID = ""
	s.UpdatedAt = time.Now().UTC()
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_controller_changed", snapshot)
	m.persist(snapshot)
	return nil
}

func (m *Manager) UpdateAudio(sessionID string, cfg AudioConfig) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	s.Audio = cfg
	s.UpdatedAt = time.Now().UTC()
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_audio_changed", snapshot)
	m.persist(snapshot)
	return nil
}
func (m *Manager) UpdatePolicy(sessionID string, p Policy) error {
	if p.MaxViewers < 0 || (p.ControllerDisconnectPolicy != "release" && p.ControllerDisconnectPolicy != "manual") {
		return ErrInvalidState
	}
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	s.Policy = p
	s.UpdatedAt = time.Now().UTC()
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_policy_changed", snapshot)
	m.persist(snapshot)
	return nil
}

func (m *Manager) Disconnect(sessionID, connectionID string) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	if _, ok := s.Connections[connectionID]; !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	delete(s.Connections, connectionID)
	if s.ControllerConnectionID == connectionID {
		s.ControllerConnectionID = ""
	}
	s.UpdatedAt = time.Now().UTC()
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_connection_changed", snapshot)
	if snapshot.ControllerConnectionID == "" {
		m.emit("stream_controller_changed", snapshot)
	}
	m.persist(snapshot)
	return nil
}

func (m *Manager) Heartbeat(sessionID, connectionID string, microphone, live bool) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	c, ok := s.Connections[connectionID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	c.LastHeartbeatAt = time.Now().UTC()
	c.ExpiresAt = c.LastHeartbeatAt.Add(15 * time.Second)
	c.Microphone = microphone
	c.MicrophoneLive = live
	s.UpdatedAt = c.LastHeartbeatAt
	snapshot := clone(s)
	m.mu.Unlock()
	m.emit("stream_connection_changed", snapshot)
	m.persist(snapshot)
	return nil
}

// SweepExpired removes connections whose heartbeat lease has elapsed. The
// caller supplies the clock so this behavior is deterministic in tests.
func (m *Manager) SweepExpired(now time.Time) int {
	m.mu.Lock()
	var expired []*RenderSession
	count := 0
	for _, s := range m.sessions {
		for id, c := range s.Connections {
			if !c.ExpiresAt.IsZero() && !now.Before(c.ExpiresAt) {
				wasController := s.ControllerConnectionID == id
				delete(s.Connections, id)
				if wasController {
					s.ControllerConnectionID = ""
				}
				s.UpdatedAt = now.UTC()
				count++
				expired = append(expired, clone(s))
			}
		}
	}
	m.mu.Unlock()
	for _, s := range expired {
		m.emit("stream_connection_expired", s)
		m.emit("stream_connection_changed", s)
		if s.ControllerConnectionID == "" {
			m.emit("stream_controller_changed", s)
		}
		m.persist(s)
	}
	return count
}

// RunLeaseReaper runs until ctx is cancelled. It is safe to run on Windows or
// Linux because it only uses Go timers and the manager's in-process state.
func (m *Manager) RunLeaseReaper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			m.SweepExpired(now)
		case <-ctx.Done():
			return
		}
	}
}

func (m *Manager) emit(typ string, s *RenderSession) {
	if m.hub != nil {
		m.hub.Broadcast(ws.Event{Type: typ, Data: clone(s)})
	}
}

func (m *Manager) persist(s *RenderSession) {
	if m.store == nil || s == nil { return }
	audio, policy, connections, err := store.EncodeStreamSessionSnapshot(s.Audio, s.Policy, s.Connections)
	if err != nil { return }
	_ = m.store.UpsertStreamSession(&model.StreamSession{
		ID: s.ID, HostID: s.HostID, AppID: s.AppID, State: s.State,
		ControllerConnectionID: s.ControllerConnectionID, AudioJSON: audio,
		PolicyJSON: policy, ConnectionsJSON: connections, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt,
	})
}

func fromRecord(record model.StreamSession) (*RenderSession, error) {
	s := &RenderSession{ID: record.ID, HostID: record.HostID, AppID: record.AppID, State: record.State, ControllerConnectionID: record.ControllerConnectionID, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt, Connections: map[string]*Connection{}}
	if err := store.DecodeStreamSessionSnapshot(&record, &s.Audio, &s.Policy, &s.Connections); err != nil { return nil, err }
	if s.Connections == nil { s.Connections = map[string]*Connection{} }
	return s, nil
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

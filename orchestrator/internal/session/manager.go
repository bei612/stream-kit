package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/ws"
)

var ErrPersistence = errors.New("session persistence failed")
var ErrCapacity = errors.New("viewer limit reached")
var ErrNotFound = errors.New("stream session or connection not found")
var ErrControllerExists = errors.New("stream session already has a controller")
var ErrControllerChanged = errors.New("controller changed since the command was prepared")
var ErrInvalidState = errors.New("invalid stream session state")

const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateDegraded = "degraded"
	StateStopping = "stopping"
	StateStopped  = "stopped"
)

type AudioConfig struct {
	Target                 AudioTarget `json:"target"`
	ProgramGainDB          float64     `json:"program_gain_db"`
	MicrophoneGainDB       float64     `json:"microphone_gain_db"`
	MicrophoneEnabled      bool        `json:"microphone_enabled"`
	BroadcastControllerMic bool        `json:"broadcast_controller_microphone"`
	ControllerMonitor      bool        `json:"controller_monitor"`
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
	ControlEpoch           uint64                 `json:"control_epoch"`
	Revision               uint64                 `json:"revision"`
	ID                     string                 `json:"session_id"`
	HostID                 int64                  `json:"host_id"`
	AppID                  int64                  `json:"app_id"`
	State                  string                 `json:"state"`
	ControllerConnectionID string                 `json:"controller_connection_id,omitempty"`
	Audio                  AudioConfig            `json:"audio"`
	Policy                 Policy                 `json:"policy"`
	Connections            map[string]*Connection `json:"connections"`
	Resumable              map[string]*Connection `json:"-"`
	CreatedAt              time.Time              `json:"created_at"`
	UpdatedAt              time.Time              `json:"updated_at"`
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*RenderSession
	hub      *ws.Hub
	store    *store.Store
	changed  chan struct{}
}

func NewManager(hub *ws.Hub) *Manager {
	return &Manager{sessions: make(map[string]*RenderSession), hub: hub, changed: make(chan struct{}, 1)}
}

func NewManagerWithStore(hub *ws.Hub, st *store.Store) (*Manager, error) {
	m := NewManager(hub)
	m.store = st
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
	if err := m.validateAudioTargets(); err != nil {
		return nil, err
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

func (m *Manager) Ensure(hostID, appID int64) (*RenderSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.HostID == hostID && s.AppID == appID && s.State != StateStopped {
			if s.State == StateStopping {
				return nil, ErrInvalidState
			}
			return clone(s), nil
		}
	}
	if hostID <= 0 || appID <= 0 || hostID > math.MaxUint32 || appID > math.MaxUint32 {
		return nil, ErrInvalidState
	}
	now := time.Now().UTC()
	s := &RenderSession{ID: uuid.NewString(), HostID: hostID, AppID: appID, State: StateStarting, Audio: AudioConfig{Target: AudioTarget{Epoch: 1, Mode: "upstream"}, MicrophoneEnabled: true, BroadcastControllerMic: true}, Policy: Policy{ControllerDisconnectPolicy: "release", MaxViewers: 20}, Connections: map[string]*Connection{}, CreatedAt: now, UpdatedAt: now}
	if err := m.commitLocked(s, "stream_session_created"); err != nil {
		return nil, err
	}
	return clone(s), nil
}

// mutate is the single boundary for all session commands. A rejected command or
// failed durable write never changes the live state or emits a success event.
func (m *Manager) mutate(id, event string, change func(*RenderSession) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.sessions[id]
	if !ok {
		return ErrNotFound
	}
	next := clone(current)
	if err := change(next); err != nil {
		return err
	}
	next.UpdatedAt = time.Now().UTC()
	return m.commitLocked(next, event)
}

func (m *Manager) commitLocked(next *RenderSession, event string) error {
	if next.Revision == math.MaxUint64 {
		return ErrInvalidState
	}
	// Reservation safety applies to every committed configuration and state.
	if err := m.checkAudioTargetReservation(next); err != nil {
		return err
	}
	next.Revision++
	// The ownership generation is durable, independent of heartbeat revisions,
	// and survives coalesced A -> B -> A publications.
	previous := m.sessions[next.ID]
	if previous == nil || previous.ControllerConnectionID != next.ControllerConnectionID ||
		((previous.State == StateStopping || previous.State == StateStopped) != (next.State == StateStopping || next.State == StateStopped)) {
		next.ControlEpoch = next.Revision
	}
	if err := m.persist(next); err != nil {
		return fmt.Errorf("%w: %v", ErrPersistence, err)
	}
	m.sessions[next.ID] = next
	m.emit(event, next)
	select {
	case m.changed <- struct{}{}:
	default:
	}
	return nil
}

// Changes coalesces committed mutations for the single media reconciler. The
// consumer always reads a full snapshot, so a burst cannot lose final state.
func (m *Manager) Changes() <-chan struct{} { return m.changed }

func (m *Manager) SetState(id, state string) error {
	return m.mutate(id, "stream_session_state_changed", func(s *RenderSession) error { return transitionState(s, state) })
}

func (m *Manager) AddConnection(id, userID string) (*Connection, error) {
	var result *Connection
	err := m.mutate(id, "stream_connection_changed", func(s *RenderSession) error {
		if s.State == StateStopped || s.State == StateStopping {
			return ErrInvalidState
		}
		if s.Policy.MaxViewers > 0 && len(s.Connections) >= s.Policy.MaxViewers {
			return ErrCapacity
		}
		now := time.Now().UTC()
		c := &Connection{ID: uuid.NewString(), UserID: userID, Role: "viewer", State: "connected", ConnectedAt: now, LastHeartbeatAt: now, ExpiresAt: now.Add(15 * time.Second)}
		s.Connections[c.ID] = c
		result = copyConnection(c)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (m *Manager) Claim(id, connectionID string) error {
	return m.mutate(id, "stream_controller_changed", func(s *RenderSession) error {
		if s.State == StateStopping || s.State == StateStopped {
			return ErrInvalidState
		}
		c, ok := s.Connections[connectionID]
		if !ok || !time.Now().Before(c.ExpiresAt) {
			return ErrNotFound
		}
		if s.ControllerConnectionID != "" && s.ControllerConnectionID != connectionID {
			return ErrControllerExists
		}
		for _, peer := range s.Connections {
			peer.Role = "viewer"
		}
		c.Role = "controller"
		s.ControllerConnectionID = connectionID
		return nil
	})
}
func (m *Manager) Release(id string) error {
	return m.mutate(id, "stream_controller_changed", func(s *RenderSession) error {
		for _, peer := range s.Connections {
			peer.Role = "viewer"
			peer.MicrophoneLive = false
		}
		s.ControllerConnectionID = ""
		return nil
	})
}

// Transfer compares the observed ownership generation, not the heartbeat
// revision. Even A -> B -> A cannot make a stale administrator command valid.
func (m *Manager) Transfer(id, connectionID, expectedControllerID string, expectedEpoch uint64) error {
	return m.mutate(id, "stream_controller_changed", func(s *RenderSession) error {
		if s.State == StateStopped || s.State == StateStopping {
			return ErrInvalidState
		}
		if s.ControllerConnectionID != expectedControllerID || s.ControlEpoch != expectedEpoch {
			return ErrControllerChanged
		}
		c, ok := s.Connections[connectionID]
		if !ok || !time.Now().Before(c.ExpiresAt) {
			return ErrNotFound
		}
		for _, peer := range s.Connections {
			peer.Role = "viewer"
			peer.MicrophoneLive = false
		}
		c.Role = "controller"
		s.ControllerConnectionID = connectionID
		return nil
	})
}
func (m *Manager) UpdateAudio(id string, cfg AudioConfig) error {
	if math.IsNaN(cfg.ProgramGainDB) || math.IsNaN(cfg.MicrophoneGainDB) || cfg.ProgramGainDB < -60 || cfg.ProgramGainDB > 12 || cfg.MicrophoneGainDB < -60 || cfg.MicrophoneGainDB > 12 {
		return ErrInvalidState
	}
	return m.mutate(id, "stream_audio_changed", func(s *RenderSession) error {
		// Routing has its own compare-and-set command; gain/mute updates cannot
		// overwrite endpoint selection from an older page snapshot.
		cfg.Target = s.Audio.Target
		s.Audio = cfg
		if !cfg.MicrophoneEnabled {
			for _, peer := range s.Connections {
				peer.MicrophoneLive = false
			}
		}
		return nil
	})
}
func (m *Manager) UpdatePolicy(id string, p Policy) error {
	if p.AllowViewerMicrophone || p.MaxViewers < 0 || (p.ControllerDisconnectPolicy != "release" && p.ControllerDisconnectPolicy != "manual") {
		return ErrInvalidState
	}
	return m.mutate(id, "stream_policy_changed", func(s *RenderSession) error { s.Policy = p; return nil })
}
func (m *Manager) Disconnect(id, connectionID string) error {
	return m.mutate(id, "stream_connection_changed", func(s *RenderSession) error {
		_, active := s.Connections[connectionID]
		_, resumable := s.Resumable[connectionID]
		if !active && !resumable {
			return ErrNotFound
		}
		delete(s.Connections, connectionID)
		delete(s.Resumable, connectionID)
		if s.ControllerConnectionID == connectionID {
			s.ControllerConnectionID = ""
		}
		return nil
	})
}
func (m *Manager) Heartbeat(id, connectionID string, microphone, live bool) error {
	return m.mutate(id, "stream_connection_changed", func(s *RenderSession) error {
		c, ok := s.Connections[connectionID]
		now := time.Now().UTC()
		if !ok || !now.Before(c.ExpiresAt) {
			return ErrNotFound
		}
		c.LastHeartbeatAt = now
		c.ExpiresAt = now.Add(15 * time.Second)
		c.Microphone = microphone
		c.MicrophoneLive = live && microphone && s.Audio.MicrophoneEnabled && s.ControllerConnectionID == connectionID
		return nil
	})
}
func (m *Manager) SweepExpired(now time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, current := range m.sessions {
		next := clone(current)
		expired := 0
		changed := pruneResumable(next, now)
		for id, c := range next.Connections {
			if !now.Before(c.ExpiresAt) {
				rememberExpired(next, c, now)
				delete(next.Connections, id)
				if next.ControllerConnectionID == id {
					next.ControllerConnectionID = ""
				}
				expired++
			}
		}
		if expired == 0 && !changed {
			continue
		}
		next.UpdatedAt = now.UTC()
		if err := m.commitLocked(next, "stream_connection_expired"); err != nil {
			return count, err
		}
		count += expired
	}
	return count, nil
}
func (m *Manager) RunLeaseReaper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			if _, err := m.SweepExpired(now); err != nil {
				slog.Error("session lease persistence failed", "error", err)
			}
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
func (m *Manager) persist(s *RenderSession) error {
	if m.store == nil {
		return nil
	}
	audio, policy, connections, err := store.EncodeStreamSessionSnapshot(s.Audio, s.Policy, s.Connections)
	if err != nil {
		return err
	}
	resumable, err := json.Marshal(s.Resumable)
	if err != nil {
		return err
	}
	return m.store.UpsertStreamSession(&model.StreamSession{ID: s.ID, Revision: s.Revision, ControlEpoch: s.ControlEpoch, HostID: s.HostID, AppID: s.AppID, State: s.State, ControllerConnectionID: s.ControllerConnectionID, AudioJSON: audio, PolicyJSON: policy, ConnectionsJSON: connections, ResumableJSON: string(resumable), CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt})
}

func fromRecord(record model.StreamSession) (*RenderSession, error) {
	s := &RenderSession{ID: record.ID, Revision: record.Revision, ControlEpoch: record.ControlEpoch, HostID: record.HostID, AppID: record.AppID, State: record.State, ControllerConnectionID: record.ControllerConnectionID, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt, Connections: map[string]*Connection{}}
	if err := store.DecodeStreamSessionSnapshot(&record, &s.Audio, &s.Policy, &s.Connections); err != nil {
		return nil, err
	}
	if record.ResumableJSON != "" {
		if err := json.Unmarshal([]byte(record.ResumableJSON), &s.Resumable); err != nil {
			return nil, err
		}
	}
	if s.Audio.Target == (AudioTarget{}) {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(record.AudioJSON), &fields); err != nil {
			return nil, err
		}
		if _, present := fields["target"]; present {
			return nil, ErrInvalidState
		}
		// Existing snapshots had no endpoint routing. Native upstream delivery
		// retains its previous capability-gated behavior after migration.
		s.Audio.Target = AudioTarget{Epoch: max(1, s.Revision), Mode: "upstream"}
	}
	if !s.Audio.Target.Valid() || s.Audio.Target.Epoch == 0 || s.Audio.Target.Epoch > s.Revision {
		return nil, ErrInvalidState
	}
	if s.Connections == nil {
		s.Connections = map[string]*Connection{}
	}
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
	x.Resumable = make(map[string]*Connection, len(s.Resumable))
	for id, c := range s.Resumable {
		x.Resumable[id] = copyConnection(c)
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

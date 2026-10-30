package session

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/store"
)

func expiredPeer(t *testing.T, m *Manager) (*RenderSession, *Connection) {
	t.Helper()
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	c, err := m.AddConnection(s.ID, "viewer-owner")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.sessions[s.ID].Connections[c.ID].ExpiresAt = time.Now().Add(-time.Second)
	m.mu.Unlock()
	return s, c
}

func TestExpiredResumePersistsAndNeverRestoresControl(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, c := expiredPeer(t, m)
	if n, err := m.SweepExpired(time.Now()); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	current, _ := m.Get(s.ID)
	if len(current.Connections) != 0 || current.ControllerConnectionID != "" || len(current.Resumable) != 1 {
		t.Fatal("expiry retained active authority")
	}
	public, _ := json.Marshal(current)
	if strings.Contains(string(public), c.ID) {
		t.Fatal("dormant credential exposed in public projection")
	}
	m, err = NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.ResumeConnection(s.ID, c.ID, "wrong-owner"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	resumed, err := m.ResumeConnection(s.ID, c.ID, c.UserID)
	if err != nil || resumed.Role != "viewer" || resumed.MicrophoneLive || resumed.Microphone {
		t.Fatal(resumed, err)
	}
	current, _ = m.Get(s.ID)
	if current.ControllerConnectionID != "" || len(current.Resumable) != 0 || len(current.Connections) != 1 {
		t.Fatal("resume restored authority or duplicated membership")
	}
	if _, err := m.ResumeConnection(s.ID, c.ID, c.UserID); err != nil {
		t.Fatal("response retry failed", err)
	}
	if err := m.Disconnect(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ResumeConnection(s.ID, c.ID, c.UserID); !errors.Is(err, ErrNotFound) {
		t.Fatal("explicit revocation was resurrected", err)
	}
}

func TestResumeBeforeReaperAndTerminalRevocation(t *testing.T) {
	for _, operation := range []string{"resume", "disconnect", "stop", "retention", "capacity"} {
		t.Run(operation, func(t *testing.T) {
			m := NewManager(nil)
			s, c := expiredPeer(t, m)
			want := error(nil)
			switch operation {
			case "disconnect":
				m.SweepExpired(time.Now())
				m.Disconnect(s.ID, c.ID)
				want = ErrNotFound
			case "stop":
				m.SweepExpired(time.Now())
				m.BeginStop(1, 2)
				want = ErrInvalidState
			case "retention":
				m.SweepExpired(time.Now().Add(resumeRetention))
				want = ErrNotFound
			case "capacity":
				m.SweepExpired(time.Now())
				m.mu.Lock()
				m.sessions[s.ID].Policy.MaxViewers = 1
				m.mu.Unlock()
				if _, err := m.AddConnection(s.ID, "other"); err != nil {
					t.Fatal(err)
				}
				want = ErrCapacity
			}
			peer, err := m.ResumeConnection(s.ID, c.ID, c.UserID)
			if !errors.Is(err, want) {
				t.Fatal(peer, err, want)
			}
			if err == nil && peer.Role != "viewer" {
				t.Fatal("expired controller restored")
			}
		})
	}
}

func TestResumeRetentionBound(t *testing.T) {
	s := &RenderSession{}
	now := time.Now()
	for i := 0; i < maxResumableConnections+20; i++ {
		c := &Connection{ID: time.Unix(int64(i), 0).String(), ExpiresAt: now.Add(-time.Duration(i) * time.Second)}
		rememberExpired(s, c, now)
	}
	if len(s.Resumable) != maxResumableConnections {
		t.Fatal("unbounded resume state")
	}
	if !pruneResumable(s, now.Add(resumeRetention)) || len(s.Resumable) != 0 {
		t.Fatal("expired resume state retained")
	}
}

func TestResumePersistenceFailurePreservesDormantState(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, c := expiredPeer(t, m)
	if _, err := m.SweepExpired(time.Now()); err != nil {
		t.Fatal(err)
	}
	before, _ := m.Get(s.ID)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ResumeConnection(s.ID, c.ID, c.UserID); !errors.Is(err, ErrPersistence) {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.Revision != before.Revision || len(after.Connections) != 0 || len(after.Resumable) != 1 {
		t.Fatal("failed persistence published recovery")
	}
}

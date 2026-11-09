package session

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
)

func seedHistory(t *testing.T, m *Manager, id, state string, updated time.Time) {
	t.Helper()
	s := &RenderSession{ID: id, HostID: 1, AppID: 2, Revision: 1, ControlEpoch: 1, State: state,
		Audio: AudioConfig{Target: AudioTarget{Mode: "upstream", Epoch: 1}}, Connections: map[string]*Connection{},
		CreatedAt: updated, UpdatedAt: updated}
	if err := m.persist(s); err != nil {
		t.Fatal(err)
	}
	if m.store != nil {
		// Save normally stamps the current update time; restore the fixture's
		// historical timestamp to model a database retained across service restarts.
		if err := m.store.DB.Model(&model.StreamSession{}).Where("id = ?", id).UpdateColumn("updated_at", updated).Error; err != nil {
			t.Fatal(err)
		}
	}
	m.sessions[id] = s
}

func historyStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.New(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestHistoryBoundsApplyAtStartupAndNeverRemoveLiveGenerations(t *testing.T) {
	st := historyStore(t)
	m := NewManager(nil)
	m.store = st
	now := time.Now().UTC()
	for i := range 105 {
		seedHistory(t, m, fmt.Sprintf("recent-%03d", i), StateStopped, now.Add(-time.Duration(i)*time.Minute))
	}
	seedHistory(t, m, "old", StateStopped, now.Add(-8*24*time.Hour))
	for _, state := range []string{StateStarting, StateRunning, StateDegraded, StateStopping} {
		seedHistory(t, m, state, state, now.Add(-30*24*time.Hour))
	}
	restored, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.List()) != 104 {
		t.Fatalf("retained %d sessions", len(restored.List()))
	}
	for _, id := range []string{"old", "recent-100", "recent-104"} {
		if _, err := restored.Get(id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("retained old %s: %v", id, err)
		}
		if _, err := restored.AddConnection(id, "old-viewer"); !errors.Is(err, ErrNotFound) {
			t.Fatal("removed generation admitted a client", err)
		}
		if _, err := restored.ResumeConnection(id, "old-connection", "old-viewer"); !errors.Is(err, ErrNotFound) {
			t.Fatal("removed generation resumed", err)
		}
	}
	for _, state := range []string{StateStarting, StateRunning, StateDegraded, StateStopping} {
		if _, err := restored.Get(state); err != nil {
			t.Fatal("live generation removed", state, err)
		}
	}
	records, err := st.ListStreamSessions()
	if err != nil || len(records) != 104 {
		t.Fatal("durable and live state disagree", len(records), err)
	}
}

func TestHistorySweepExpiresAtBoundaryAndLeavesRecentStopped(t *testing.T) {
	m := NewManager(nil)
	now := time.Now().UTC()
	seedHistory(t, m, "boundary", StateStopped, now.Add(-historyMaxAge))
	seedHistory(t, m, "recent", StateStopped, now.Add(-historyMaxAge+time.Second))
	if _, err := m.SweepExpired(now); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get("boundary"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := m.Get("recent"); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryDeleteFailureRollsBackBatchAndKeepsMemory(t *testing.T) {
	st := historyStore(t)
	m := NewManager(nil)
	m.store = st
	now := time.Now().UTC()
	for _, id := range []string{"old-a", "old-b"} {
		seedHistory(t, m, id, StateStopped, now.Add(-8*24*time.Hour))
	}
	if err := st.DB.Exec(`CREATE TRIGGER reject_history_delete BEFORE DELETE ON stream_sessions WHEN OLD.id = 'old-b' BEGIN SELECT RAISE(ABORT, 'test failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if count, err := m.PruneStoppedHistory(now); count != 0 || !errors.Is(err, ErrPersistence) {
		t.Fatal(count, err)
	}
	if len(m.List()) != 2 {
		t.Fatal("failure removed live history")
	}
	records, err := st.ListStreamSessions()
	if err != nil || len(records) != 2 {
		t.Fatal("partial durable deletion", len(records), err)
	}
	if err := st.DB.Exec("DROP TRIGGER reject_history_delete").Error; err != nil {
		t.Fatal(err)
	}
	if count, err := m.PruneStoppedHistory(now); count != 2 || err != nil {
		t.Fatal(count, err)
	}
}

func TestHistoryStoreRejectsMixedLiveBatchWithoutPartialDelete(t *testing.T) {
	st := historyStore(t)
	m := NewManager(nil)
	m.store = st
	now := time.Now()
	seedHistory(t, m, "ended", StateStopped, now)
	seedHistory(t, m, "running", StateRunning, now)
	if err := st.DeleteStoppedStreamSessions([]string{"ended", "running"}); err == nil {
		t.Fatal("live record accepted")
	}
	records, err := st.ListStreamSessions()
	if err != nil || len(records) != 2 {
		t.Fatal("failed batch did not roll back", len(records), err)
	}
}

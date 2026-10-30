package session

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/stream-kit/orchestrator/internal/store"
)

func TestStoppingGenerationSurvivesRestartAndCannotBeRejoined(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Ensure(1, 771)
	c, _ := m.AddConnection(s.ID, "viewer")
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	unrelated, _ := m.Ensure(2, 771)
	old, _ := m.Get(s.ID)
	id, err := m.BeginStop(1, 771)
	if err != nil || id != s.ID {
		t.Fatalf("begin: %s %v", id, err)
	}
	closed, _ := m.Get(id)
	if closed.State != StateStopping || closed.ControlEpoch <= old.ControlEpoch || len(closed.Connections) != 0 || closed.ControllerConnectionID != "" {
		t.Fatalf("capabilities survived stop: %+v", closed)
	}
	other, _ := m.Get(unrelated.ID)
	if other.State != unrelated.State || other.Revision != unrelated.Revision {
		t.Fatal("another host was changed")
	}
	m, err = NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Ensure(1, 771); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("ensure while stopping: %v", err)
	}
	if _, err = m.AddConnection(id, "old invitation"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("old invitation admitted: %v", err)
	}
	if err = m.Claim(id, c.ID); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("claim while stopping: %v", err)
	}
	if err = m.Heartbeat(id, c.ID, true, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old connection survived: %v", err)
	}
	if retry, err := m.BeginStop(1, 771); err != nil || retry != id {
		t.Fatalf("retry: %s %v", retry, err)
	}
	if err = m.CompleteStop(id); err != nil {
		t.Fatal(err)
	}
	if err = m.SetState(id, StateRunning); !errors.Is(err, ErrInvalidState) {
		t.Fatal("terminal generation revived")
	}
	fresh, err := m.Ensure(1, 771)
	if err != nil || fresh.ID == id {
		t.Fatalf("new administrator admission: %+v %v", fresh, err)
	}
	if _, err = m.AddConnection(id, "old invitation"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("terminal invitation admitted: %v", err)
	}
	if err = m.CompleteStop(fresh.ID); !errors.Is(err, ErrInvalidState) {
		t.Fatal("unconfirmed fresh generation stopped")
	}
}

func TestStopPersistenceFailureKeepsLiveGeneration(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Ensure(1, 771)
	c, _ := m.AddConnection(s.ID, "viewer")
	before, _ := m.Get(s.ID)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.BeginStop(1, 771); !errors.Is(err, ErrPersistence) {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.Revision != before.Revision || after.State != before.State || after.Connections[c.ID] == nil {
		t.Fatal("failed transaction revoked a live generation")
	}
}

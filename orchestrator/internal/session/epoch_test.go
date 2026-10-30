package session

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/store"
)

func TestControlEpochSurvivesCoalescedTransferAndRestart(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "session.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	a, err := m.AddConnection(s.ID, "a")
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.AddConnection(s.ID, "b")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Claim(s.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	first, _ := m.Get(s.ID)
	if err := m.Heartbeat(s.ID, a.ID, true, true); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAudio(s.ID, AudioConfig{MicrophoneEnabled: true}); err != nil {
		t.Fatal(err)
	}
	stable, _ := m.Get(s.ID)
	if stable.ControlEpoch != first.ControlEpoch || stable.Revision <= first.Revision {
		t.Fatal("routine updates changed the ownership generation")
	}
	if err := m.Transfer(s.ID, b.ID, a.ID, stable.ControlEpoch); err != nil {
		t.Fatal(err)
	}
	middle, _ := m.Get(s.ID)
	if err := m.Transfer(s.ID, a.ID, b.ID, middle.ControlEpoch); err != nil {
		t.Fatal(err)
	}
	if err := m.Transfer(s.ID, b.ID, a.ID, first.ControlEpoch); !errors.Is(err, ErrControllerChanged) {
		t.Fatal("stale administrator command survived A B A", err)
	}
	current, _ := m.Get(s.ID)
	if current.ControlEpoch <= first.ControlEpoch || current.ControlEpoch != current.Revision {
		t.Fatal("coalesced transfer lost ownership history")
	}
	restored, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := restored.Get(s.ID)
	if after.ControlEpoch != current.ControlEpoch {
		t.Fatal("restart lost control epoch")
	}
	if _, err := restored.SweepExpired(time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	expired, _ := restored.Get(s.ID)
	if expired.ControlEpoch <= after.ControlEpoch || expired.ControllerConnectionID != "" {
		t.Fatal("expiration did not revoke the generation")
	}
	if err := restored.Heartbeat(s.ID, a.ID, true, true); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired attachment was renewed", err)
	}
}

func TestFailedTransferDoesNotPublishEpoch(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "session.db"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	a, err := m.AddConnection(s.ID, "a")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Claim(s.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	before, _ := m.Get(s.ID)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.Release(s.ID); !errors.Is(err, ErrPersistence) {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.ControlEpoch != before.ControlEpoch || after.ControllerConnectionID != a.ID {
		t.Fatal("failed durable write changed live authority")
	}
}

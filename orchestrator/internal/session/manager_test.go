package session

import (
	"errors"
	"github.com/stream-kit/orchestrator/internal/store"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConcurrentControllerTransferIsAtomic(t *testing.T) {
	m := NewManager(nil)
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := m.AddConnection(s.ID, "a")
	b, _ := m.AddConnection(s.ID, "b")
	c, _ := m.AddConnection(s.ID, "c")
	if err = m.Claim(s.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if err = m.Heartbeat(s.ID, a.ID, true, true); err != nil {
		t.Fatal(err)
	}
	observed, _ := m.Get(s.ID)
	results := make(chan error, 2)
	for _, id := range []string{b.ID, c.ID} {
		go func(target string) { results <- m.Transfer(s.ID, target, a.ID, observed.ControlEpoch) }(id)
	}
	successes := 0
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrControllerChanged) {
			t.Fatal(err)
		}
	}
	if successes != 1 {
		t.Fatalf("expected one winning transfer, got %d", successes)
	}
	current, _ := m.Get(s.ID)
	controllers := 0
	for id, peer := range current.Connections {
		if peer.Role == "controller" {
			controllers++
			if id != current.ControllerConnectionID {
				t.Fatal("controller identity mismatch")
			}
		}
	}
	if controllers != 1 || current.Connections[a.ID].MicrophoneLive {
		t.Fatal("previous controller retained authority")
	}
	if err = m.Transfer(s.ID, "missing", current.ControllerConnectionID, current.ControlEpoch); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.Revision != current.Revision || after.ControllerConnectionID != current.ControllerConnectionID {
		t.Fatal("invalid transfer changed state")
	}
}

func TestRejectedConnectionDoesNotHoldManagerLock(t *testing.T) {
	m := NewManager(nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = m.AddConnection("missing", "user")
		s, err := m.Ensure(1, 2)
		if err != nil {
			t.Error(err)
			return
		}
		_ = m.UpdatePolicy(s.ID, Policy{MaxViewers: 1, ControllerDisconnectPolicy: "release"})
		_, _ = m.AddConnection(s.ID, "a")
		if _, err = m.AddConnection(s.ID, "b"); err != ErrCapacity {
			t.Errorf("capacity: %v", err)
		}
		m.List()
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("rejected connection deadlocked manager")
	}
}

func TestFailedPersistenceDoesNotPublishState(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "sessions.db"))
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
	if err = st.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = m.AddConnection(s.ID, "a"); !errors.Is(err, ErrPersistence) {
		t.Fatalf("got %v", err)
	}
	current, _ := m.Get(s.ID)
	if current.Revision != s.Revision || len(current.Connections) != 0 {
		t.Fatal("failed write changed live state")
	}
	if _, err = m.Ensure(3, 4); !errors.Is(err, ErrPersistence) {
		t.Fatalf("create: %v", err)
	}
	if len(m.List()) != 1 {
		t.Fatal("failed create became visible")
	}
}

func TestConcurrentCommitsPersistMonotonicRevision(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "sessions.db"))
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
	c, err := m.AddConnection(s.ID, "a")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Heartbeat(s.ID, c.ID, true, true); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	current, _ := m.Get(s.ID)
	record, err := st.GetStreamSession(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Revision != 22 || record.Revision != current.Revision {
		t.Fatalf("revisions: memory %d stored %d", current.Revision, record.Revision)
	}
	if current.Connections[c.ID].MicrophoneLive {
		t.Fatal("viewer reported live microphone")
	}
}

func TestControllerIsExclusiveAndAudioUpdates(t *testing.T) {
	m := NewManager(nil)
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
	if err := m.Claim(s.ID, b.ID); err == nil {
		t.Fatal("expected exclusive controller error")
	}
	if err := m.UpdateAudio(s.ID, AudioConfig{MicrophoneEnabled: true, BroadcastControllerMic: true, MicrophoneGainDB: -3}); err != nil {
		t.Fatal(err)
	}
	got, err := m.Get(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ControllerConnectionID != a.ID || got.Audio.MicrophoneGainDB != -3 {
		t.Fatalf("unexpected session state: %+v", got)
	}
}

func TestReleaseClearsRoles(t *testing.T) {
	m := NewManager(nil)
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := m.AddConnection(s.ID, "a")
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Release(s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := m.Get(s.ID)
	if got.ControllerConnectionID != "" || got.Connections[c.ID].Role != "viewer" {
		t.Fatalf("controller was not released: %+v", got)
	}
}

func TestSweepExpiredReleasesController(t *testing.T) {
	m := NewManager(nil)
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	c, err := m.AddConnection(s.ID, "a")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := m.SweepExpired(c.ExpiresAt.Add(time.Millisecond)); err != nil || got != 1 {
		t.Fatalf("expired connections: got %d, want 1", got)
	}
	current, err := m.Get(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.ControllerConnectionID != "" || len(current.Connections) != 0 {
		t.Fatalf("expired controller was not released: %+v", current)
	}
}

func TestInvalidPolicyRejected(t *testing.T) {
	m := NewManager(nil)
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.UpdatePolicy(s.ID, Policy{MaxViewers: -1, ControllerDisconnectPolicy: "release"}); err != ErrInvalidState {
		t.Fatalf("got %v, want ErrInvalidState", err)
	}
}

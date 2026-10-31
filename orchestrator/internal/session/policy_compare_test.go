package session

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/stream-kit/orchestrator/internal/store"
)

func TestConcurrentPolicyChangesHaveOneWinner(t *testing.T) {
	m := NewManager(nil)
	s, _ := m.Ensure(1, 2)
	results := make(chan error, 2)
	for _, capacity := range []int{1, 2} {
		go func(capacity int) {
			next := s.Policy
			next.MaxViewers = capacity
			results <- m.CompareAndSetPolicy(s.ID, next, s.Policy)
		}(capacity)
	}
	winners := 0
	for range 2 {
		if err := <-results; err == nil {
			winners++
		} else if !errors.Is(err, ErrPolicyChanged) {
			t.Fatal(err)
		}
	}
	if winners != 1 {
		t.Fatalf("winners=%d", winners)
	}
}

func TestPolicyCompareIgnoresConnectionsAndRetainsExistingViewers(t *testing.T) {
	m := NewManager(nil)
	s, _ := m.Ensure(1, 2)
	_, _ = m.AddConnection(s.ID, "one")
	_, _ = m.AddConnection(s.ID, "two")
	next := s.Policy
	next.MaxViewers = 1
	if err := m.CompareAndSetPolicy(s.ID, next, s.Policy); err != nil {
		t.Fatal(err)
	}
	current, _ := m.Get(s.ID)
	if len(current.Connections) != 2 {
		t.Fatal("capacity reduction disconnected existing viewers")
	}
	if _, err := m.AddConnection(s.ID, "three"); !errors.Is(err, ErrCapacity) {
		t.Fatal(err)
	}
	if err := m.CompareAndSetPolicy(s.ID, s.Policy, s.Policy); !errors.Is(err, ErrPolicyChanged) {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.Revision != current.Revision || after.Policy.MaxViewers != 1 {
		t.Fatal("stale capacity overwrote current policy")
	}
}

func TestLegacyManualPolicyDescribesActualReleaseBehavior(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Ensure(1, 2)
	legacy := s.Policy
	legacy.ControllerDisconnectPolicy = "manual"
	if err := m.CompareAndSetPolicy(s.ID, legacy, s.Policy); !errors.Is(err, ErrInvalidState) {
		t.Fatal(err)
	}
	s.Policy = legacy
	if err := m.persist(s); err != nil {
		t.Fatal(err)
	}
	restored, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := restored.Get(s.ID)
	if got.Policy.ControllerDisconnectPolicy != "release" {
		t.Fatal("unimplemented policy still advertised")
	}
}

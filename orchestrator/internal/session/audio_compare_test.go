package session

import (
	"errors"
	"testing"
)

func TestAudioCompareDoesNotReenableRevokedMicrophone(t *testing.T) {
	m := NewManager(nil)
	s, _ := m.Ensure(1, 2)
	base := s.Audio
	disabled := base
	disabled.MicrophoneEnabled = false
	if err := m.CompareAndSetAudio(s.ID, disabled, base); err != nil {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	stale := base
	stale.ProgramGainDB = -6
	if err := m.CompareAndSetAudio(s.ID, stale, base); !errors.Is(err, ErrAudioChanged) {
		t.Fatal(err)
	}
	got, _ := m.Get(s.ID)
	if got.Audio.MicrophoneEnabled || got.Revision != after.Revision {
		t.Fatal("stale edit committed")
	}
}

func TestAudioCompareIsIndependentOfTargetAndConnections(t *testing.T) {
	m := NewManager(nil)
	s, _ := m.Ensure(1, 2)
	_, _ = m.AddConnection(s.ID, "viewer")
	if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, localTarget("render", "capture")); err != nil {
		t.Fatal(err)
	}
	before, _ := m.Get(s.ID)
	next := s.Audio
	next.ProgramGainDB = -6
	if err := m.CompareAndSetAudio(s.ID, next, s.Audio); err != nil {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.Audio.Target != before.Audio.Target || after.Audio.ProgramGainDB != -6 {
		t.Fatal("route lost or gain not committed")
	}
}

func TestConcurrentAudioEditsHaveOneWinner(t *testing.T) {
	m := NewManager(nil)
	s, _ := m.Ensure(1, 2)
	results := make(chan error, 2)
	for _, gain := range []float64{-3, -6} {
		go func(gain float64) {
			next := s.Audio
			next.ProgramGainDB = gain
			results <- m.CompareAndSetAudio(s.ID, next, s.Audio)
		}(gain)
	}
	winners := 0
	for range 2 {
		if err := <-results; err == nil {
			winners++
		} else if !errors.Is(err, ErrAudioChanged) {
			t.Fatal(err)
		}
	}
	if winners != 1 {
		t.Fatalf("winners=%d", winners)
	}
}

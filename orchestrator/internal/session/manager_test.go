package session

import "testing"

func TestControllerIsExclusiveAndAudioUpdates(t *testing.T) {
	m := NewManager(nil)
	s := m.Ensure(1, 2)
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
	s := m.Ensure(1, 2)
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

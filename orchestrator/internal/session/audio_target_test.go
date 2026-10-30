package session

import (
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
)

func localTarget(render, capture string) AudioTarget {
	return AudioTarget{Mode: "local", RenderDeviceID: render, CaptureDeviceID: capture}
}

func TestAudioTargetEpochPersistenceAndCompareAndSet(t *testing.T) {
	database := filepath.Join(t.TempDir(), "session.db")
	st, err := store.New(database)
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
	c, _ := m.AddConnection(s.ID, "viewer")
	if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, localTarget("render-a", "capture-a")); err != nil {
		t.Fatal(err)
	}
	bound, _ := m.Get(s.ID)
	if bound.Audio.Target.Epoch != bound.Revision || bound.ControlEpoch != s.ControlEpoch {
		t.Fatal("routing and controller generations were conflated")
	}
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Heartbeat(s.ID, c.ID, true, true); err != nil {
		t.Fatal(err)
	}
	// A stale general audio form cannot change route authority, even if it
	// includes a forged target epoch and different native endpoint identifiers.
	if err := m.UpdateAudio(s.ID, AudioConfig{MicrophoneEnabled: true, MicrophoneGainDB: -3, Target: AudioTarget{Epoch: 999, Mode: "disabled"}}); err != nil {
		t.Fatal(err)
	}
	stable, _ := m.Get(s.ID)
	if stable.Audio.Target != bound.Audio.Target || stable.Audio.MicrophoneGainDB != -3 {
		t.Fatal("gain/heartbeat/controller change overwrote routing")
	}
	if err := m.UpdateAudioTarget(s.ID, stable.Audio.Target.Epoch, localTarget("render-b", "capture-b")); err != nil {
		t.Fatal(err)
	}
	middle, _ := m.Get(s.ID)
	if err := m.UpdateAudioTarget(s.ID, middle.Audio.Target.Epoch, localTarget("render-a", "capture-a")); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAudioTarget(s.ID, bound.Audio.Target.Epoch, AudioTarget{Mode: "disabled"}); !errors.Is(err, ErrAudioTargetChanged) {
		t.Fatal("A B A accepted stale configuration", err)
	}
	current, _ := m.Get(s.ID)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.New(database)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored, err := NewManagerWithStore(nil, reopened)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := restored.Get(s.ID)
	if after.Audio.Target != current.Audio.Target {
		t.Fatal("restart lost desired target or epoch")
	}
	if err := restored.UpdateAudioTarget(s.ID, after.Audio.Target.Epoch, after.Audio.Target); err != nil {
		t.Fatal(err)
	}
	retried, _ := restored.Get(s.ID)
	if retried.Audio.Target.Epoch <= after.Audio.Target.Epoch {
		t.Fatal("explicit retry did not advance generation")
	}
}

func TestConcurrentAudioTargetClaimsAndEdits(t *testing.T) {
	m := NewManager(nil)
	a, _ := m.Ensure(1, 2)
	b, _ := m.Ensure(1, 3)
	results := make(chan error, 2)
	for _, s := range []*RenderSession{a, b} {
		go func(s *RenderSession) {
			results <- m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, localTarget("render", "capture"))
		}(s)
	}
	successes := 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		} else if !errors.Is(err, ErrAudioTargetInUse) {
			t.Fatal(err)
		}
	}
	if successes != 1 {
		t.Fatal("endpoint reservation was not exclusive")
	}
	a, _ = m.Get(a.ID)
	b, _ = m.Get(b.ID)
	if a.Audio.Target.Mode != "local" {
		a, b = b, a
	}
	if err := m.UpdateAudioTarget(b.ID, b.Audio.Target.Epoch, localTarget("capture", "render")); !errors.Is(err, ErrAudioTargetInUse) {
		t.Fatal("reverse-direction duplicate escaped reservation")
	}
	if err := m.SetState(a.ID, StateStopping); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAudioTarget(b.ID, b.Audio.Target.Epoch, localTarget("render", "capture")); !errors.Is(err, ErrAudioTargetInUse) {
		t.Fatal("stopping session lost reservation early")
	}
	if err := m.SetState(a.ID, StateStopped); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAudioTarget(b.ID, b.Audio.Target.Epoch, localTarget("render", "capture")); err != nil {
		t.Fatal(err)
	}
	if err := m.SetState(a.ID, StateRunning); !errors.Is(err, ErrAudioTargetInUse) {
		t.Fatal("reactivation stole reserved endpoints")
	}
	stopped, _ := m.Get(a.ID)
	if stopped.State != StateStopped {
		t.Fatal("failed reactivation changed state")
	}
	b, _ = m.Get(b.ID)
	for _, target := range []AudioTarget{{Mode: "disabled"}, {Mode: "upstream"}} {
		go func(target AudioTarget) { results <- m.UpdateAudioTarget(b.ID, b.Audio.Target.Epoch, target) }(target)
	}
	successes = 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		} else if !errors.Is(err, ErrAudioTargetChanged) {
			t.Fatal(err)
		}
	}
	if successes != 1 {
		t.Fatal("competing administrator edits both committed")
	}
}

func TestAudioTargetFailedCommitEmitsNoStateOrEvent(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "session.db"))
	if err != nil {
		t.Fatal(err)
	}
	hub := ws.NewHub(zap.NewNop())
	defer hub.Close()
	m, err := NewManagerWithStore(hub, st)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Ensure(1, 2)
	<-m.Changes()
	client := ws.NewClient()
	if !hub.Register(client) {
		t.Fatal("register observer")
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, localTarget("render", "capture")); !errors.Is(err, ErrPersistence) {
		t.Fatal(err)
	}
	after, _ := m.Get(s.ID)
	if after.Revision != s.Revision || after.Audio.Target != s.Audio.Target {
		t.Fatal("failed durable write changed target")
	}
	select {
	case <-m.Changes():
		t.Fatal("failed change woke publisher")
	default:
	}
	select {
	case <-client.Events():
		t.Fatal("failed change emitted success")
	default:
	}
}

func TestAudioTargetRejectsInvalidCommands(t *testing.T) {
	for _, target := range []AudioTarget{
		{}, {Mode: "automatic"}, {Mode: "disabled", RenderDeviceID: "render"},
		{Mode: "upstream", CaptureDeviceID: "capture"}, localTarget("same", "same"),
		localTarget("", "capture"), localTarget(" render", "capture"), localTarget("render\x00", "capture"),
		localTarget(strings.Repeat("r", 4097), "capture"),
	} {
		m := NewManager(nil)
		s, _ := m.Ensure(1, 2)
		if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, target); !errors.Is(err, ErrInvalidState) {
			t.Fatalf("invalid target accepted: %v", err)
		}
		after, _ := m.Get(s.ID)
		if after.Revision != s.Revision {
			t.Fatal("invalid command changed revision")
		}
	}
	m := NewManager(nil)
	s, _ := m.Ensure(1, 2)
	if err := m.UpdateAudioTarget(s.ID, 0, AudioTarget{Mode: "disabled"}); !errors.Is(err, ErrInvalidState) {
		t.Fatal("missing precondition")
	}
	if err := m.UpdateAudioTarget("missing", 1, AudioTarget{Mode: "disabled"}); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing session")
	}
	m.sessions[s.ID].Revision = math.MaxUint64
	if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, AudioTarget{Mode: "disabled"}); !errors.Is(err, ErrInvalidState) {
		t.Fatal("overflow accepted")
	}
	m.sessions[s.ID].Revision = s.Revision
	if err := m.SetState(s.ID, StateStopped); err != nil {
		t.Fatal(err)
	}
	if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, AudioTarget{Mode: "disabled"}); !errors.Is(err, ErrInvalidState) {
		t.Fatal("stopped session edited")
	}
}

func TestAudioTargetLegacySnapshotAndCorruptReservations(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "session.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Ensure(1, 2)
	record, _ := st.GetStreamSession(s.ID)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(record.AudioJSON), &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "target")
	body, _ := json.Marshal(fields)
	record.AudioJSON = string(body)
	if err := st.UpsertStreamSession(record); err != nil {
		t.Fatal(err)
	}
	restored, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := restored.Get(s.ID)
	if legacy.Audio.Target.Mode != "upstream" || legacy.Audio.Target.Epoch != legacy.Revision {
		t.Fatal("legacy migration changed default behavior")
	}
	for _, invalid := range []string{`null`, `{}`, `{"epoch":999,"mode":"local","render_device_id":"r","capture_device_id":"c"}`} {
		fields["target"] = json.RawMessage(invalid)
		body, _ = json.Marshal(fields)
		record.AudioJSON = string(body)
		if err := st.UpsertStreamSession(record); err != nil {
			t.Fatal(err)
		}
		if _, err := NewManagerWithStore(nil, st); !errors.Is(err, ErrInvalidState) {
			t.Fatalf("corrupt target accepted: %v", err)
		}
	}
	// Restore through valid domain state, then simulate two conflicting durable
	// snapshots (e.g. external database editing). Startup must fail atomically.
	if err := m.UpdateAudioTarget(s.ID, s.Audio.Target.Epoch, localTarget("r", "c")); err != nil {
		t.Fatal(err)
	}
	other, _ := m.Ensure(1, 3)
	duplicate, _ := st.GetStreamSession(other.ID)
	bound, _ := m.Get(s.ID)
	duplicate.Revision = bound.Revision
	duplicate.AudioJSON, _, _, err = store.EncodeStreamSessionSnapshot(bound.Audio, other.Policy, other.Connections)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertStreamSession(duplicate); err != nil {
		t.Fatal(err)
	}
	if _, err := NewManagerWithStore(nil, st); !errors.Is(err, ErrAudioTargetInUse) {
		t.Fatal("conflicting persisted endpoints accepted", err)
	}
}

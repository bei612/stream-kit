package session

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestNativeObservationPreservesRealAdmissionAndExpiresFailedStartup(t *testing.T) {
	st := historyStore(t)
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	inviteExpiry := now.Add(2 * time.Minute)
	s, err := m.EnsureAdmission(1, 2, inviteExpiry)
	if err != nil {
		t.Fatal(err)
	}
	c, err := m.AddConnection(s.ID, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Heartbeat(s.ID, c.ID, false, false); err != nil {
		t.Fatal(err)
	}
	current, _ := m.Get(s.ID)
	if !current.AdmissionUntil.Equal(inviteExpiry) {
		t.Fatal("heartbeat extended launch authority")
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "", inviteExpiry.Add(-time.Second)); err != nil || id != "" {
		t.Fatal("valid invitation revoked", id, err)
	}
	mediaExpiry := inviteExpiry.Add(time.Minute)
	if err := m.ReserveMediaAdmission(s.ID, c.ID, mediaExpiry); err != nil {
		t.Fatal(err)
	}
	m, err = NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	current, _ = m.Get(s.ID)
	if !current.AdmissionUntil.Equal(mediaExpiry) {
		t.Fatal("media-ticket expiry was not durable")
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "", inviteExpiry); err != nil || id != "" {
		t.Fatal("unexpired media ticket revoked", id, err)
	}
	id, err := m.ObserveNativeRuntime(1, 2, "", mediaExpiry)
	if err != nil || id != s.ID {
		t.Fatal("expired startup not revoked", id, err)
	}
	current, _ = m.Get(s.ID)
	if current.State != StateStopping || len(current.Connections) != 0 || current.ControllerConnectionID != "" {
		t.Fatal("stopping did not revoke authority", current)
	}
	// A failed/unavailable media acknowledgement does not call CompleteStop.
	m, err = NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "", mediaExpiry.Add(time.Second)); err != nil || id != s.ID {
		t.Fatal("pending revocation was not recoverable", id, err)
	}
	if _, err := m.EnsureAdmission(1, 2, mediaExpiry.Add(time.Minute)); !errors.Is(err, ErrInvalidState) {
		t.Fatal("pending stop reopened", err)
	}
	if err := m.CompleteStop(s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ResumeConnection(s.ID, c.ID, "viewer"); !errors.Is(err, ErrInvalidState) {
		t.Fatal("old client restored", err)
	}
	fresh, err := m.EnsureAdmission(1, 2, mediaExpiry.Add(time.Minute))
	if err != nil || fresh.ID == s.ID {
		t.Fatal("new admission reused terminal authority", err)
	}
}

func TestMediaAdmissionAndObservedExpiryShareAtomicGenerationBoundary(t *testing.T) {
	st := historyStore(t)
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 20 {
		now := time.Now()
		s, err := m.EnsureAdmission(1, int64(i+1), now.Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		c, err := m.AddConnection(s.ID, "viewer")
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		start := make(chan struct{})
		var admissionErr, observationErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			admissionErr = m.ReserveMediaAdmission(s.ID, c.ID, now.Add(3*time.Minute))
		}()
		go func() {
			defer wg.Done()
			<-start
			_, observationErr = m.ObserveNativeRuntime(1, int64(i+1), "", now.Add(2*time.Minute))
		}()
		close(start)
		wg.Wait()
		if observationErr != nil {
			t.Fatal(observationErr)
		}
		current, _ := m.Get(s.ID)
		if admissionErr == nil && current.State != StateStarting {
			t.Fatal("successful ticket reservation was overtaken by stale expiry observation")
		}
		if admissionErr != nil && (!errors.Is(admissionErr, ErrInvalidState) || current.State != StateStopping) {
			t.Fatal("unexpected expiry race result", admissionErr, current.State)
		}
	}
}

func TestNativeExitRevokesRunningGenerationImmediatelyAndPreservesOtherHost(t *testing.T) {
	m := NewManager(nil)
	now := time.Now()
	s, _ := m.EnsureAdmission(1, 2, now.Add(2*time.Minute))
	other, _ := m.EnsureAdmission(3, 2, now.Add(2*time.Minute))
	if _, err := m.ObserveNativeRuntime(1, 2, "native-instance-a", now); err != nil {
		t.Fatal(err)
	}
	current, _ := m.Get(s.ID)
	if current.State != StateRunning {
		t.Fatal("positive native observation did not confirm running")
	}
	c, _ := m.AddConnection(s.ID, "viewer")
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "", now.Add(time.Second)); err != nil || id != s.ID {
		t.Fatal(id, err)
	}
	current, _ = m.Get(s.ID)
	untouched, _ := m.Get(other.ID)
	if current.State != StateStopping || len(current.Connections) != 0 || untouched.State != StateStarting {
		t.Fatal("native exit affected wrong authority")
	}
	if _, err := m.ObserveNativeRuntime(1, 2, "native-instance-a", now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	current, _ = m.Get(s.ID)
	if current.State != StateStopping {
		t.Fatal("new native run reopened old authority")
	}
}

func TestObservedStopPersistenceFailureKeepsLiveGeneration(t *testing.T) {
	st := historyStore(t)
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Ensure(1, 2)
	c, _ := m.AddConnection(s.ID, "viewer")
	if err := m.Claim(s.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	before, _ := m.Get(s.ID)
	if err := st.DB.Exec(`CREATE TRIGGER reject_observed_update BEFORE UPDATE ON stream_sessions BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "", time.Now()); id != "" || !errors.Is(err, ErrPersistence) {
		t.Fatal(id, err)
	}
	after, _ := m.Get(s.ID)
	if after.Revision != before.Revision || after.State != before.State || after.ControllerConnectionID != c.ID {
		t.Fatal("failed write changed live authority")
	}
	if err := st.DB.Exec("DROP TRIGGER reject_observed_update").Error; err != nil {
		t.Fatal(err)
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "", time.Now()); id != s.ID || err != nil {
		t.Fatal(id, err)
	}
}

func TestNativeInstanceReplacementAndObservedRevocationSurviveRestart(t *testing.T) {
	st := historyStore(t)
	m, err := NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s, _ := m.EnsureAdmission(1, 2, now.Add(2*time.Minute))
	if _, err := m.ObserveNativeRuntime(1, 2, "instance-a", now); err != nil {
		t.Fatal(err)
	}
	m, err = NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	current, _ := m.Get(s.ID)
	if current.NativeInstanceID != "instance-a" || current.State != StateRunning {
		t.Fatal("native identity was not durable")
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "instance-b", now.Add(time.Second)); id != s.ID || err != nil {
		t.Fatal("replacement reused old generation", id, err)
	}
	m, err = NewManagerWithStore(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	current, _ = m.Get(s.ID)
	if !current.ObservedStop || current.State != StateStopping {
		t.Fatal("observed revocation reason was not durable")
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "instance-b", now.Add(2*time.Second)); id != s.ID || err != nil {
		t.Fatal("observed revocation could not retry without killing replacement", id, err)
	}
	if err := m.CompleteStop(s.ID); err != nil {
		t.Fatal(err)
	}
}

func TestExplicitNativeStopCannotBeCompletedWhileSameInstanceStillRuns(t *testing.T) {
	m := NewManager(nil)
	now := time.Now()
	s, _ := m.Ensure(1, 2)
	if _, err := m.ObserveNativeRuntime(1, 2, "same-instance", now); err != nil {
		t.Fatal(err)
	}
	if _, err := m.BeginStop(1, 2); err != nil {
		t.Fatal(err)
	}
	if id, err := m.ObserveNativeRuntime(1, 2, "same-instance", now.Add(time.Second)); id != "" || err != nil {
		t.Fatal("explicit stop completed without native acknowledgement", id, err)
	}
	current, _ := m.Get(s.ID)
	if current.ObservedStop || current.State != StateStopping {
		t.Fatal("explicit stop semantics changed")
	}
}

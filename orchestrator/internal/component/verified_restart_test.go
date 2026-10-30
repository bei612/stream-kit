package component

import (
	"context"
	"errors"
	"testing"
	"time"
)

func runningOwnedComponent(t *testing.T) (*Manager, *ManagedProcess) {
	t.Helper()
	m := crashManager(t, 0)
	m.configs["test"].Env["STREAM_KIT_CRASH_CHILD"] = "wait"
	if err := m.Start("test"); err != nil {
		t.Fatal(err)
	}
	return m, ownedProcess(m.components["test"])
}

func TestVerifiedRestartRejectsStaleOwnershipAndFailedGuard(t *testing.T) {
	m, old := runningOwnedComponent(t)
	called := false
	check := func(context.Context, int, string) error { called = true; return nil }
	if err := m.RestartVerified(context.Background(), "test", old.PID+1, old.InstanceID, check, check); !errors.Is(err, ErrRestartOwnership) {
		t.Fatal(err)
	}
	if called {
		t.Fatal("stale owner reached validation")
	}
	if err := m.RestartVerified(context.Background(), "test", old.PID, "wrong-instance", check, check); !errors.Is(err, ErrRestartOwnership) {
		t.Fatal("PID alone accepted as ownership", err)
	}
	rejected := errors.New("configuration version changed")
	if err := m.RestartVerified(context.Background(), "test", old.PID, old.InstanceID,
		func(context.Context, int, string) error { return rejected }, check); !errors.Is(err, rejected) {
		t.Fatal(err)
	}
	if called || ownedProcess(m.components["test"]) != old {
		t.Fatal("failed guard changed live process")
	}
}

func TestVerifiedRestartSerializesChecksAndUsesOwnedReplacement(t *testing.T) {
	m, old := runningOwnedComponent(t)
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	check := func(context.Context, int, string) error { return nil }
	go func() {
		done <- m.RestartVerified(context.Background(), "test", old.PID, old.InstanceID,
			func(ctx context.Context, pid int, instance string) error {
				if pid != old.PID || instance != old.InstanceID {
					return errors.New("wrong original process")
				}
				close(entered)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}, func(_ context.Context, pid int, instance string) error {
				current := ownedProcess(m.components["test"])
				if current == nil || current == old || current.PID != pid || current.InstanceID != instance || instance == old.InstanceID {
					return errors.New("unowned replacement")
				}
				select {
				case <-old.Done:
					return nil
				default:
					return errors.New("original process still alive")
				}
			})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("check did not start")
	}
	err := m.RestartVerified(context.Background(), "test", old.PID, old.InstanceID, check, check)
	close(release)
	if !errors.Is(err, ErrRestartConflict) {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestVerifiedRestartCancellationPreservesOriginal(t *testing.T) {
	m, old := runningOwnedComponent(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := m.RestartVerified(ctx, "test", old.PID, old.InstanceID,
		func(context.Context, int, string) error { cancel(); return nil },
		func(context.Context, int, string) error {
			t.Fatal("cancelled operation launched replacement")
			return nil
		})
	if !errors.Is(err, context.Canceled) || ownedProcess(m.components["test"]) != old {
		t.Fatal(err)
	}
}

func TestVerifiedRestartReportsPostLaunchVerificationFailure(t *testing.T) {
	m, old := runningOwnedComponent(t)
	unverified := errors.New("running revision mismatch")
	err := m.RestartVerified(context.Background(), "test", old.PID, old.InstanceID,
		func(context.Context, int, string) error { return nil },
		func(context.Context, int, string) error { return unverified })
	if !errors.Is(err, unverified) {
		t.Fatal(err)
	}
	current := ownedProcess(m.components["test"])
	if current == nil || current == old {
		t.Fatal("verification failure hid replacement state")
	}
}

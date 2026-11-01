package component

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestPreparationFailureDoesNotLaunchComponent(t *testing.T) {
	m := crashManager(t, 0)
	expected := errors.New("resource preparation failed")
	m.prepare = func(context.Context, string, config.ComponentConfig) error { return expected }
	if err := m.Start("test"); !errors.Is(err, expected) {
		t.Fatalf("unexpected start: %v", err)
	}
	state, err := m.Get("test")
	if err != nil || state.PID != 0 || state.Status != StatusError {
		t.Fatalf("launched after failed preparation: %+v, %v", state, err)
	}
}

func TestShutdownCancelsPendingPreparation(t *testing.T) {
	m := crashManager(t, 0)
	entered := make(chan struct{})
	m.prepare = func(ctx context.Context, _ string, _ config.ComponentConfig) error {
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}
	started := make(chan error, 1)
	go func() { started <- m.Start("test") }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("preparation was not invoked")
	}
	done := make(chan struct{})
	go func() { m.Shutdown(); close(done) }()
	select {
	case err := <-started:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("start did not cancel")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown deadlocked on preparation")
	}
}

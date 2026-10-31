package component

import (
	"context"
	"errors"
	"time"
)

var ErrRestartConflict = errors.New("component lifecycle operation is in progress")
var ErrRestartOwnership = errors.New("component is not the expected owned running process")

// RestartVerified keeps ownership, preflight, the caller's signed checks, and
// process replacement under one lifecycle lock. Hooks must honor ctx and must
// not call lifecycle operations on this component. A verification failure
// after launch is returned as a failure; it is not an automatic rollback.
func (m *Manager) RestartVerified(ctx context.Context, name string, expectedPID int, expectedInstance string,
	before, after func(context.Context, int, string) error,
) error {
	cs, ok := m.components[name]
	if !ok || expectedPID <= 0 || len(expectedInstance) != 32 || before == nil || after == nil {
		return ErrRestartOwnership
	}
	if !cs.opMu.TryLock() {
		return ErrRestartConflict
	}
	defer cs.opMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	if err := ctx.Err(); err != nil {
		return err
	}
	old := ownedProcess(cs)
	if old == nil || old.PID != expectedPID || old.InstanceID != expectedInstance || m.closing.Load() {
		return ErrRestartOwnership
	}
	if err := m.preflight(ctx, name); err != nil {
		return err
	}
	if err := before(ctx, old.PID, old.InstanceID); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if ownedProcess(cs) != old {
		return ErrRestartOwnership
	}
	if err := m.stop(name, cs); err != nil {
		return err
	}
	// Once stopped, complete the replacement even if the HTTP caller leaves.
	// Manager shutdown still cancels start through the manager's own context.
	if err := m.start(name, cs, false); err != nil {
		return err
	}
	current := ownedProcess(cs)
	if current == nil {
		return ErrRestartOwnership
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := after(ctx, current.PID, current.InstanceID); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if ownedProcess(cs) != current {
		return ErrRestartOwnership
	}
	return nil
}

func ownedProcess(cs *ComponentState) *ManagedProcess {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if cs.process == nil || cs.PID != cs.process.PID {
		return nil
	}
	select {
	case <-cs.process.Done:
		return nil
	default:
		return cs.process
	}
}

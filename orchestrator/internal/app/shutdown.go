package app

import "context"

// Shutdown closes upload admission, cancels active extraction/registration, and
// waits for pipeline-owned temporary files and locks to be released.
// Add and Wait are serialized by workMu; repeated callers share one completion.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.workMu.Lock()
	if !m.closing {
		m.closing = true
		m.cancelWork()
		go func() { m.workers.Wait(); close(m.workDone) }()
	}
	m.workMu.Unlock()
	select {
	case <-m.workDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

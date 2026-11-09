package session

import "time"

// ReserveMediaAdmission persists the exact lifetime of a media ticket before it
// is signed. Unlike a heartbeat, a ticket authorizes an actual launch attempt.
func (m *Manager) ReserveMediaAdmission(id, connectionID string, until time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return ErrNotFound
	}
	if s.State == StateStopped || s.State == StateStopping {
		return ErrInvalidState
	}
	connection := s.Connections[connectionID]
	if connection == nil || !time.Now().Before(connection.ExpiresAt) {
		return ErrNotFound
	}
	if !until.After(s.AdmissionUntil) {
		return nil
	}
	next := clone(s)
	next.AdmissionUntil, next.UpdatedAt = until, time.Now().UTC()
	return m.commitLocked(next, "stream_session_state_changed")
}

// ObserveNativeRuntime accepts only an authoritative, successful encoder runtime
// observation whose host/app identity the caller has verified. It never kills a
// native process. A returned stopping generation still requires media revocation
// acknowledgement before CompleteStop can commit its terminal state.
func (m *Manager) ObserveNativeRuntime(hostID, appID int64, nativeInstance string, now time.Time) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var current *RenderSession
	for _, s := range m.sessions {
		if s.HostID == hostID && s.AppID == appID && s.State != StateStopped {
			if current != nil {
				return "", ErrInvalidState
			}
			current = s
		}
	}
	if current == nil {
		return "", nil
	}
	if nativeInstance != "" {
		if current.State == StateStopping {
			if current.ObservedStop || (current.NativeInstanceID != "" && current.NativeInstanceID != nativeInstance) {
				return m.confirmObservedExitLocked(current, now)
			}
			return "", nil
		}
		if current.NativeInstanceID != "" && current.NativeInstanceID != nativeInstance {
			// The process restarted between polls. End the old viewing generation
			// without sending a native stop to the newly observed execution.
			return m.beginStopLocked(current, now, true)
		}
		if current.State == StateRunning && current.NativeInstanceID == nativeInstance {
			return "", nil
		}
		next := clone(current)
		if err := transitionState(next, StateRunning); err != nil {
			return "", err
		}
		next.UpdatedAt = now.UTC()
		next.NativeInstanceID = nativeInstance
		return "", m.commitLocked(next, "stream_session_state_changed")
	}
	if current.State == StateStopping {
		return m.confirmObservedExitLocked(current, now)
	}
	// Before native execution is first observed, only a real issued invitation or
	// media ticket keeps the generation pending. Passive heartbeats cannot keep a
	// failed startup indefinitely alive. Once running was observed, native exit
	// revokes every old client immediately, including tickets not yet redeemed.
	if current.State == StateStarting && now.Before(current.AdmissionUntil) {
		return "", nil
	}
	return m.beginStopLocked(current, now, true)
}

// Persist the fact that native execution has ended before an acknowledgement
// retry or restart. Recovery must never send a native stop to a later instance.
func (m *Manager) confirmObservedExitLocked(current *RenderSession, now time.Time) (string, error) {
	if current.ObservedStop {
		return current.ID, nil
	}
	next := clone(current)
	next.ObservedStop, next.UpdatedAt = true, now.UTC()
	if err := m.commitLocked(next, "stream_session_state_changed"); err != nil {
		return "", err
	}
	return next.ID, nil
}

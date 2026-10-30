package session

import "time"

// transitionState makes terminal generations irreversible and centralizes
// capability revocation for both observed state changes and stop commands.
func transitionState(s *RenderSession, state string) error {
	if state != StateStarting && state != StateRunning && state != StateDegraded && state != StateStopping && state != StateStopped {
		return ErrInvalidState
	}
	if (s.State == StateStopped && state != StateStopped) ||
		(s.State == StateStopping && state != StateStopping && state != StateStopped) {
		return ErrInvalidState
	}
	s.State = state
	if state == StateStopping || state == StateStopped {
		s.ControllerConnectionID = ""
		s.Connections = map[string]*Connection{}
		s.Resumable = nil
	}
	return nil
}

// BeginStop revokes a target's current viewing generation before its native
// process is stopped. Persistence failure leaves every live capability intact;
// a committed stopping generation stays closed across retries and restarts.
func (m *Manager) BeginStop(hostID, appID int64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var current *RenderSession
	for _, s := range m.sessions {
		if s.HostID == hostID && s.AppID == appID && s.State != StateStopped {
			if current != nil {
				return "", ErrInvalidState // Never partially revoke an ambiguous target.
			}
			current = s
		}
	}
	if current == nil {
		return "", nil
	}
	if current.State == StateStopping {
		return current.ID, nil
	}
	next := clone(current)
	if err := transitionState(next, StateStopping); err != nil {
		return "", err
	}
	next.UpdatedAt = time.Now().UTC()
	if err := m.commitLocked(next, "stream_session_state_changed"); err != nil {
		return "", err
	}
	return next.ID, nil
}

// CompleteStop marks only the generation whose native stop was confirmed.
// An administrator may subsequently create a fresh session, but old invitations
// and connection credentials continue to refer to the terminal generation.
func (m *Manager) CompleteStop(id string) error {
	if id == "" {
		return nil
	}
	return m.mutate(id, "stream_session_state_changed", func(s *RenderSession) error {
		if s.State != StateStopping && s.State != StateStopped {
			return ErrInvalidState
		}
		return transitionState(s, StateStopped)
	})
}

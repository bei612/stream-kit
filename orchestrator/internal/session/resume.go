package session

import "time"

const resumeRetention = 15 * time.Minute
const maxResumableConnections = 128

func pruneResumable(s *RenderSession, now time.Time) bool {
	changed := false
	for id, c := range s.Resumable {
		if c == nil || !now.Before(c.ExpiresAt.Add(resumeRetention)) {
			delete(s.Resumable, id)
			changed = true
		}
	}
	return changed
}

func rememberExpired(s *RenderSession, c *Connection, now time.Time) {
	if !now.Before(c.ExpiresAt.Add(resumeRetention)) {
		return
	}
	if s.Resumable == nil {
		s.Resumable = map[string]*Connection{}
	}
	if len(s.Resumable) >= maxResumableConnections {
		var oldest *Connection
		for _, candidate := range s.Resumable {
			if oldest == nil || candidate.ExpiresAt.Before(oldest.ExpiresAt) {
				oldest = candidate
			}
		}
		if oldest != nil {
			delete(s.Resumable, oldest.ID)
		}
	}
	copy := copyConnection(c)
	copy.Role = "viewer"
	copy.State = "expired"
	copy.Microphone = false
	copy.MicrophoneLive = false
	s.Resumable[c.ID] = copy
}

// ResumeConnection restores only a credential-bound, temporarily expired peer.
// The handler verifies token purpose and expiry; explicit removal and terminal
// generations erase this authority. Retried responses do not create new peers.
func (m *Manager) ResumeConnection(id, connectionID, subject string) (*Connection, error) {
	var result *Connection
	err := m.mutate(id, "stream_connection_resumed", func(s *RenderSession) error {
		if s.State == StateStopped || s.State == StateStopping {
			return ErrInvalidState
		}
		now := time.Now().UTC()
		c := s.Connections[connectionID]
		if c == nil {
			c = s.Resumable[connectionID]
		}
		if c == nil || c.UserID != subject || !now.Before(c.ExpiresAt.Add(resumeRetention)) {
			return ErrNotFound
		}
		if !now.Before(c.ExpiresAt) {
			active := 0
			for _, peer := range s.Connections {
				if now.Before(peer.ExpiresAt) {
					active++
				}
			}
			if s.Policy.MaxViewers > 0 && active >= s.Policy.MaxViewers {
				return ErrCapacity
			}
			if s.ControllerConnectionID == connectionID {
				s.ControllerConnectionID = ""
			}
			c.Role = "viewer"
			c.Microphone = false
			c.MicrophoneLive = false
		}
		c.State = "connected"
		c.LastHeartbeatAt = now
		c.ExpiresAt = now.Add(15 * time.Second)
		s.Connections[connectionID] = c
		delete(s.Resumable, connectionID)
		result = copyConnection(c)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

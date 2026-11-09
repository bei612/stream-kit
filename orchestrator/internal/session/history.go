package session

import (
	"fmt"
	"sort"
	"time"
)

const historyMaxCount = 100
const historyMaxAge = 7 * 24 * time.Hour

// PruneStoppedHistory bounds diagnostic history without changing active sessions,
// application watch keys or their revocation rules. Missing generations fail closed.
func (m *Manager) PruneStoppedHistory(now time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pruneStoppedHistoryLocked(now)
}

func (m *Manager) pruneStoppedHistoryLocked(now time.Time) (int, error) {
	var history []*RenderSession
	for _, s := range m.sessions {
		if s.State == StateStopped {
			history = append(history, s)
		}
	}
	sort.Slice(history, func(i, j int) bool {
		if history[i].UpdatedAt.Equal(history[j].UpdatedAt) {
			return history[i].ID < history[j].ID
		}
		return history[i].UpdatedAt.After(history[j].UpdatedAt)
	})
	var ids []string
	cutoff := now.Add(-historyMaxAge)
	for i, s := range history {
		if i >= historyMaxCount || !s.UpdatedAt.After(cutoff) {
			ids = append(ids, s.ID)
		}
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if m.store != nil {
		if err := m.store.DeleteStoppedStreamSessions(ids); err != nil {
			return 0, fmt.Errorf("%w: prune history: %v", ErrPersistence, err)
		}
	}
	for _, id := range ids {
		delete(m.sessions, id)
	}
	return len(ids), nil
}

package component

import (
	"errors"
	"fmt"
	"time"
)

func (m *Manager) startFailed(name string, cs *ComponentState, err error) {
	cs.mu.Lock()
	cs.Status, cs.LastError = StatusError, err.Error()
	wait := errors.Is(err, errSessionUnavailable)
	if wait {
		cs.generation++
	}
	generation := cs.generation
	cs.mu.Unlock()
	m.emitEvent(name, StatusError)
	if wait {
		go m.retrySession(name, cs, generation)
	}
}

var errSessionUnavailable = errors.New("等待指定 Windows 用户登录活动桌面会话")

// Session numbers are transient. Only a token-verified owner is eligible;
// preserve the configured preference when it is still owned by that user.
func chooseWorkerSession(preferred uint32, owned []uint32) (uint32, error) {
	for _, id := range owned {
		if id == preferred {
			return id, nil
		}
	}
	if len(owned) == 1 {
		return owned[0], nil
	}
	if len(owned) == 0 {
		return 0, errSessionUnavailable
	}
	return 0, fmt.Errorf("multiple active sessions belong to the render user; select one explicitly")
}

// A missing login is not a process crash. Retry only this transient condition,
// with the lifecycle generation ensuring explicit Stop cancels the request.
func (m *Manager) retrySession(name string, cs *ComponentState, generation uint64) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-m.ctx.Done():
		return
	case <-timer.C:
	}
	cs.opMu.Lock()
	defer cs.opMu.Unlock()
	cs.mu.Lock()
	eligible := cs.generation == generation && cs.Status == StatusError && cs.process == nil
	cs.mu.Unlock()
	if eligible && !m.closing.Load() {
		_ = m.start(name, cs, true)
	}
}

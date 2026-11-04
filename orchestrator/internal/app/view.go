package app

import (
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/session"
)

// Lifecycle is the management projection, not an authorization grant. Commands
// still recheck authoritative state under runtimeMu when they execute.
type Lifecycle struct {
	SessionState string `json:"session_state"`
	CanLaunch    bool   `json:"can_launch"`
	CanStop      bool   `json:"can_stop"`
	CanEdit      bool   `json:"can_edit"`
}
type View struct {
	model.App
	Lifecycle Lifecycle `json:"lifecycle"`
}

func (m *Manager) view(a model.App) View {
	l := Lifecycle{SessionState: session.StateStopped}
	if m.sessions != nil && a.SunshineAppID > 0 {
		for _, s := range m.sessions.List() {
			if s.AppID == int64(a.SunshineAppID) && s.State != session.StateStopped {
				l.SessionState = s.State
				break
			}
		}
	}
	switch a.Status {
	case model.AppStatusReady, model.AppStatusStopped, model.AppStatusCrashed:
		l.CanLaunch = true
		l.CanEdit = true
	case model.AppStatusRegisterFailed:
		l.CanEdit = true
	case model.AppStatusRunning:
		l.CanLaunch = true
	}
	l.CanStop = a.Status == model.AppStatusRunning || l.SessionState != session.StateStopped
	if l.SessionState != session.StateStopped {
		l.CanEdit = false
	}
	if l.SessionState == session.StateStopping {
		l.CanLaunch = false
	}
	return View{App: a, Lifecycle: l}
}
func (m *Manager) ListViews() ([]View, error) {
	m.runtimeMu.Lock()
	defer m.runtimeMu.Unlock()
	apps, err := m.store.ListApps()
	if err != nil {
		return nil, err
	}
	views := make([]View, 0, len(apps))
	for _, a := range apps {
		views = append(views, m.view(a))
	}
	return views, nil
}
func (m *Manager) GetView(id string) (*View, error) {
	m.runtimeMu.Lock()
	defer m.runtimeMu.Unlock()
	a, err := m.store.GetApp(id)
	if err != nil {
		return nil, err
	}
	v := m.view(*a)
	return &v, nil
}

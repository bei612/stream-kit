package app

import (
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/session"
	"testing"
)

func TestLifecycleProjectionKeepsPendingStopActionable(t *testing.T) {
	m, st, req := localFixture(t)
	a, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.UpdateAppFields(a.ID, map[string]interface{}{"sunshine_app_id": 771, "status": model.AppStatusStopped}); err != nil {
		t.Fatal(err)
	}
	sessions := session.NewManager(nil)
	m.ConfigureSessionLifecycle(sessions, nil)
	s, err := sessions.Ensure(1, 771)
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{session.StateStarting, session.StateStopping, session.StateStopped} {
		if err = sessions.SetState(s.ID, state); err != nil {
			t.Fatal(err)
		}
		v, err := m.GetView(a.ID)
		if err != nil {
			t.Fatal(err)
		}
		list, err := m.ListViews()
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != 1 || list[0].Lifecycle != v.Lifecycle {
			t.Fatal("list/detail lifecycle diverged")
		}
		if v.Lifecycle.CanStop != (state != session.StateStopped) || v.Lifecycle.CanEdit != (state == session.StateStopped) || v.Lifecycle.CanLaunch != (state != session.StateStopping) {
			t.Fatalf("incorrect lifecycle: %+v", v.Lifecycle)
		}
	}
}

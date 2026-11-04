package component

import (
	"errors"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
	"testing"
	"testing/synctest"
	"time"
)

func TestSessionSelectionAcrossLogin(t *testing.T) {
	for _, tc := range []struct {
		name              string
		preferred         uint32
		owned             []uint32
		want              uint32
		unavailable, fail bool
	}{
		{"before login", 1, nil, 0, true, true},
		{"session changed after reboot", 1, []uint32{3}, 3, false, false},
		{"old number owned by another user excluded", 1, []uint32{4}, 4, false, false},
		{"configured owner still active", 1, []uint32{1, 3}, 1, false, false},
		{"ambiguous user sessions", 1, []uint32{3, 4}, 0, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := chooseWorkerSession(tc.preferred, tc.owned)
			if got != tc.want || (err != nil) != tc.fail || errors.Is(err, errSessionUnavailable) != tc.unavailable {
				t.Fatalf("got %d %v", got, err)
			}
		})
	}
}

func TestLoginRetryRespectsStopAndShutdown(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			m := NewManager(map[string]config.ComponentConfig{"sunshine": {}}, 1, t.TempDir(), nil, zap.NewNop())
			cs := m.components["sunshine"]
			m.startFailed("sunshine", cs, errSessionUnavailable)
			if shutdown {
				m.Shutdown()
			} else {
				if err := m.Stop("sunshine"); err != nil {
					t.Fatal(err)
				}
				defer m.Shutdown()
			}
			time.Sleep(6 * time.Second)
			info, _ := m.Get("sunshine")
			if info.Status != StatusStopped || info.PID != 0 {
				t.Fatalf("retry overrode explicit stop: %+v", info)
			}
		})
	}
}

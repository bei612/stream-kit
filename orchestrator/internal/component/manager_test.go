package component

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

// Only this child executable exits; no deployed service is involved.
func TestComponentCrashChild(t *testing.T) {
	if os.Getenv("STREAM_KIT_CRASH_CHILD") == "wait" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	if os.Getenv("STREAM_KIT_CRASH_CHILD") == "1" {
		os.Exit(7)
	}
}

func TestConcurrentStartAndHealthErrorRetainSingleProcess(t *testing.T) {
	m := crashManager(t, 0)
	cfg := m.configs["test"]
	cfg.Env["STREAM_KIT_CRASH_CHILD"] = "wait"
	m.configs["test"] = cfg
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Start("test"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	cs := m.components["test"]
	cs.mu.Lock()
	proc, generation := cs.process, cs.generation
	cs.Status = StatusError // health timeout must not permit a duplicate process
	cs.mu.Unlock()
	if err := m.Start("test"); err != nil {
		t.Fatal(err)
	}
	cs.mu.Lock()
	same := cs.process == proc && proc != nil && cs.generation == generation && generation == 1
	cs.mu.Unlock()
	if !same {
		t.Fatal("start duplicated a live process")
	}
}

func crashManager(t *testing.T, attempts int) *Manager {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(map[string]config.ComponentConfig{"test": {
		ExePath: exe, Args: "-test.run=^TestComponentCrashChild$",
		Env:            map[string]string{"STREAM_KIT_CRASH_CHILD": "1"},
		RestartOnCrash: true, MaxRestartAttempts: attempts, RestartDelay: 1,
	}}, 1, t.TempDir(), nil, zap.NewNop())
	t.Cleanup(m.Shutdown)
	return m
}

func awaitState(t *testing.T, m *Manager, status Status) *ComponentInfo {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		info, err := m.Get("test")
		if err != nil {
			t.Fatal(err)
		}
		if info.Status == status {
			return info
		}
		time.Sleep(10 * time.Millisecond)
	}
	info, _ := m.Get("test")
	t.Fatalf("waiting for %s: %+v", status, info)
	return nil
}

func TestAutomaticRestartHonorsCrashBudget(t *testing.T) {
	m := crashManager(t, 2)
	if err := m.Start("test"); err != nil {
		t.Fatal(err)
	}
	info := awaitState(t, m, StatusError)
	if info.CrashCount != 3 || info.PID != 0 {
		t.Fatalf("unexpected final state: %+v", info)
	}
}

func TestStopInvalidatesPendingAutomaticRestart(t *testing.T) {
	m := crashManager(t, 5)
	if err := m.Start("test"); err != nil {
		t.Fatal(err)
	}
	awaitState(t, m, StatusCrashed)
	if err := m.Stop("test"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1300 * time.Millisecond)
	info, _ := m.Get("test")
	if info.Status != StatusStopped || info.CrashCount != 1 || info.PID != 0 {
		t.Fatalf("stopped component restarted: %+v", info)
	}
}

func TestPreviousHealthCallbackCannotChangeNewLifetime(t *testing.T) {
	m := NewManager(map[string]config.ComponentConfig{"test": {}}, 1, t.TempDir(), nil, zap.NewNop())
	t.Cleanup(m.Shutdown)
	if err := m.Start("test"); err != nil {
		t.Fatal(err)
	}
	cs := m.components["test"]
	cs.mu.Lock()
	previous := cs.healthChecker
	cs.mu.Unlock()
	if err := m.Restart("test"); err != nil {
		t.Fatal(err)
	}
	if m.healthTransition("test", cs, previous, StatusStarting, StatusRunning, "") {
		t.Fatal("old health callback changed new lifetime")
	}
	select {
	case <-previous.ctx.Done():
	default:
		t.Fatal("previous health checker not cancelled")
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.Restart("test"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if err := m.Stop("test"); err != nil {
		t.Fatal(err)
	}
	info, _ := m.Get("test")
	if info.Status != StatusStopped {
		t.Fatalf("unexpected state: %+v", info)
	}
}

func TestHealthCloseCancelsOutstandingRequest(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
	}))
	defer server.Close()
	hc := NewHealthChecker("test", config.HealthCheckConfig{URL: server.URL}, zap.NewNop())
	defer hc.Close()
	done := make(chan bool, 1)
	go func() { done <- hc.Check() }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("request not started")
	}
	hc.Close()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("cancelled request passed")
		}
	case <-time.After(time.Second):
		t.Fatal("health request did not cancel")
	}
}

func TestShutdownRejectsSubsequentStarts(t *testing.T) {
	m := NewManager(map[string]config.ComponentConfig{"test": {}}, 1, t.TempDir(), nil, zap.NewNop())
	if err := m.Start("test"); err != nil {
		t.Fatal(err)
	}
	m.Shutdown()
	if err := m.Start("test"); err == nil {
		t.Fatal("start accepted after shutdown")
	}
	if err := m.Restart("test"); err == nil {
		t.Fatal("restart accepted after shutdown")
	}
	info, _ := m.Get("test")
	if info.Status != StatusStopped {
		t.Fatalf("unexpected shutdown state: %+v", info)
	}
}

func TestForceStopWaitsForOwnedChild(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	proc, err := StartProcess(exe, "-test.run=^TestComponentCrashChild$", "",
		map[string]string{"STREAM_KIT_CRASH_CHILD": "wait"}, NewRingBuffer(10), zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	go proc.RunWait()
	t.Cleanup(func() {
		if err := forceStop(proc); err != nil {
			t.Error(err)
		}
	})
	if err := forceStop(proc); err != nil {
		t.Fatal(err)
	}
	select {
	case <-proc.Done:
	default:
		t.Fatal("termination returned before process exit")
	}
}

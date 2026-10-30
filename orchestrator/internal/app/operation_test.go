package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func TestApplicationOperationsRespectPipelineOwnership(t *testing.T) {
	for _, operation := range []string{"delete", "stop", "launch", "select", "retry"} {
		t.Run(operation, func(t *testing.T) {
			m, st, req := localFixture(t)
			a, err := m.RegisterLocal(req)
			if err != nil {
				t.Fatal(err)
			}
			unlock, err := m.TryLock(a.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer unlock()
			switch operation {
			case "delete":
				err = m.DeleteApp(a.ID)
			case "stop":
				err = m.StopApp(a.ID)
			case "launch":
				_, err = m.LaunchApp(a.ID)
			case "select":
				err = m.SelectExe(a.ID, "entry.exe")
			case "retry":
				err = m.RetryRegister(a.ID)
			}
			if !errors.Is(err, ErrOperationConflict) {
				t.Fatalf("busy operation must conflict: %v", err)
			}
			saved, err := st.GetApp(a.ID)
			if err != nil || saved.Status != a.Status {
				t.Fatalf("busy operation changed registration: %+v %v", saved, err)
			}
			if _, err := os.Stat(a.ExePath); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSelectEntryReportsRegistrationFailure(t *testing.T) {
	m, st, req := localFixture(t)
	a, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(a.AppDir, "entry.exe")
	if err := os.WriteFile(entry, []byte{'M', 'Z', 0, 0}, 0700); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateAppFields(a.ID, map[string]interface{}{"source": model.AppSourceArchive, "status": model.AppStatusDetecting}); err != nil {
		t.Fatal(err)
	}
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer native.Close()
	m.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: native.URL}, zap.NewNop())
	if err := m.SelectExe(a.ID, "entry.exe"); err == nil {
		t.Fatal("encoder failure reported as successful selection")
	}
	saved, err := st.GetApp(a.ID)
	if err != nil || saved.Status != model.AppStatusRegisterFailed || saved.ExePath != entry {
		t.Fatalf("entry must remain recoverable: %+v %v", saved, err)
	}
}

func TestRetryReservesOwnershipUntilRegistrationCompletes(t *testing.T) {
	m, st, req := localFixture(t)
	a, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateAppFields(a.ID, map[string]interface{}{"status": model.AppStatusRegisterFailed}); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	m.onEvent = func(id string, status model.AppStatus) {
		if status == model.AppStatusRegistering {
			close(entered)
			<-release
		}
	}
	if err := m.RetryRegister(a.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("registration did not start")
	}
	for _, operate := range []func(string) error{m.DeleteApp, m.StopApp, m.RetryRegister} {
		if err := operate(a.ID); !errors.Is(err, ErrOperationConflict) {
			close(release)
			t.Fatalf("registration ownership lost: %v", err)
		}
	}
	close(release)
	deadline := time.Now().Add(3 * time.Second)
	for {
		unlock, err := m.TryLock(a.ID)
		if err == nil {
			unlock()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("registration lock was not released")
		}
		time.Sleep(time.Millisecond)
	}
	saved, err := st.GetApp(a.ID)
	if err != nil || saved.Status != model.AppStatusReady {
		t.Fatalf("registration did not finish: %+v %v", saved, err)
	}
	if err := m.DeleteApp(a.ID); err != nil {
		t.Fatal(err)
	}
}

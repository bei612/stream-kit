package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

func TestRestartRecoveryPreservesFilesIdentityAndResumableStates(t *testing.T) {
	for _, status := range []model.AppStatus{model.AppStatusUploading, model.AppStatusExtracting,
		model.AppStatusDetecting, model.AppStatusRegistering, model.AppStatusRegisterFailed,
		model.AppStatusReady, model.AppStatusRunning, model.AppStatusStopped, model.AppStatusCrashed} {
		t.Run(string(status), func(t *testing.T) {
			root := t.TempDir()
			database := filepath.Join(root, "state.sqlite")
			st, err := store.New(database)
			if err != nil {
				t.Fatal(err)
			}
			id := uuid.NewString()
			// Deliberately outside AppsDir: startup cannot trust persisted paths
			// as authority to recursively remove data.
			directory := filepath.Join(root, "original-program")
			if err := os.MkdirAll(directory, 0700); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(directory, "entry.exe")
			if err := os.WriteFile(file, []byte("preserve"), 0600); err != nil {
				t.Fatal(err)
			}
			record := &model.App{ID: id, Name: "recover", Status: status, AppDir: directory,
				ExePath: file, SunshineAppID: 771, Source: model.AppSourceArchive}
			if err := st.CreateApp(record); err != nil {
				t.Fatal(err)
			}
			st.Close()
			st, err = store.New(database)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			m := NewManager(st, &config.Config{Storage: config.StorageConfig{AppsDir: filepath.Join(root, "managed")}}, nil, nil, nil, zap.NewNop())
			if err := m.RecoverInterruptedOperations(); err != nil {
				t.Fatal(err)
			}
			want := status
			if status == model.AppStatusUploading || status == model.AppStatusExtracting {
				want = model.AppStatusError
			}
			if status == model.AppStatusRegistering {
				want = model.AppStatusRegisterFailed
			}
			got, err := st.GetApp(id)
			if err != nil || got.Status != want || got.SunshineAppID != 771 || got.ExePath != file {
				t.Fatalf("invalid recovered record: %+v %v", got, err)
			}
			if got.Status != status && got.ErrorMessage == "" {
				t.Fatal("recovery needs an actionable reason")
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != "preserve" {
				t.Fatalf("recovery modified program files: %s %v", data, err)
			}
			if err := m.RecoverInterruptedOperations(); err != nil {
				t.Fatal(err)
			}
			again, err := st.GetApp(id)
			if err != nil || again.Status != got.Status || !again.UpdatedAt.Equal(got.UpdatedAt) {
				t.Fatal("repeated startup recovery changed settled state", err)
			}
		})
	}
}

func TestRecoveryRejectsPersistenceFailure(t *testing.T) {
	m, st, req := localFixture(t)
	a, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateAppFields(a.ID, map[string]interface{}{"status": model.AppStatusRegistering}); err != nil {
		t.Fatal(err)
	}
	if err := st.DB.Exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE ON apps BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if err := m.RecoverInterruptedOperations(); err == nil {
		t.Fatal("startup accepted failed recovery write")
	}
	saved, err := st.GetApp(a.ID)
	if err != nil || saved.Status != model.AppStatusRegistering {
		t.Fatal("failed recovery changed state", err)
	}
}

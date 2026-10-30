package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/store"
)

func TestUploadArchiveRecoveryIsScopedAndRepeatable(t *testing.T) {
	m, st, _ := localFixture(t)
	m.config.Storage.TempDir = filepath.Join(t.TempDir(), "staging")
	a, err := m.CreateUploadArchive("program.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.File.Write([]byte("incomplete payload")); err != nil {
		t.Fatal(err)
	}
	if err := a.File.Close(); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(m.config.Storage.TempDir, "keep.txt")
	if err := os.WriteFile(unrelated, []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	// Reload the persistent journal through another connection, as at startup.
	var database string
	if err := st.DB.Raw("SELECT file FROM pragma_database_list WHERE name = 'main'").Scan(&database).Error; err != nil {
		t.Fatal(err)
	}
	reopened, err := store.New(database)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	m.store = reopened
	if err := m.RecoverInterruptedOperations(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(a.Path); !os.IsNotExist(err) {
		t.Fatal("registered staging file remains", err)
	}
	if data, err := os.ReadFile(unrelated); err != nil || string(data) != "unrelated" {
		t.Fatal("unrelated file changed", err)
	}
	if records, err := reopened.ListUploadArchives(); err != nil || len(records) != 0 {
		t.Fatal("journal not cleared", err)
	}
	if err := m.RecoverInterruptedOperations(); err != nil {
		t.Fatal(err)
	}
}

func TestUploadArchiveCleanupRetainsFailedOwnershipChecks(t *testing.T) {
	for _, scenario := range []string{"changed_root", "directory", "invalid_id", "missing"} {
		t.Run(scenario, func(t *testing.T) {
			m, st, _ := localFixture(t)
			m.config.Storage.TempDir = t.TempDir()
			a, err := m.CreateUploadArchive("program.7z")
			if err != nil {
				t.Fatal(err)
			}
			a.File.Close()
			switch scenario {
			case "changed_root":
				m.config.Storage.TempDir = t.TempDir()
			case "directory":
				if err := os.Remove(a.Path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(a.Path, 0700); err != nil {
					t.Fatal(err)
				}
			case "invalid_id":
				a.record.ID = "../outside"
			case "missing":
				if err := os.Remove(a.Path); err != nil {
					t.Fatal(err)
				}
			}
			err = a.Cleanup()
			if (err == nil) != (scenario == "missing") {
				t.Fatalf("unexpected cleanup outcome: %v", err)
			}
			records, err := st.ListUploadArchives()
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "missing" {
				if len(records) != 0 {
					t.Fatal("missing file journal not cleared")
				}
			} else {
				if len(records) != 1 {
					t.Fatal("failed cleanup discarded ownership")
				}
				if _, err := os.Lstat(a.Path); err != nil {
					t.Fatal("failed cleanup removed file", err)
				}
			}
		})
	}
}

func TestUploadArchivePersistenceFailureDoesNotAcceptPayload(t *testing.T) {
	m, st, _ := localFixture(t)
	m.config.Storage.TempDir = t.TempDir()
	if err := st.DB.Exec(`CREATE TRIGGER reject_upload BEFORE INSERT ON upload_archives BEGIN SELECT RAISE(ABORT,'fixture failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if a, err := m.CreateUploadArchive("program.zip"); err == nil || a != nil {
		t.Fatal("untracked upload accepted")
	}
	files, err := os.ReadDir(m.config.Storage.TempDir)
	if err != nil || len(files) != 0 {
		t.Fatal("failed journal write leaked staging file", err)
	}
}

func TestUploadArchiveRetriesCleanupAfterJournalCommitFailure(t *testing.T) {
	m, st, _ := localFixture(t)
	m.config.Storage.TempDir = t.TempDir()
	a, err := m.CreateUploadArchive("program.zip")
	if err != nil {
		t.Fatal(err)
	}
	a.File.Close()
	if err := st.DB.Exec(`CREATE TRIGGER reject_cleanup BEFORE DELETE ON upload_archives BEGIN SELECT RAISE(ABORT,'fixture failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if err := a.Cleanup(); err == nil {
		t.Fatal("failed journal delete ignored")
	}
	if _, err := os.Stat(a.Path); !os.IsNotExist(err) {
		t.Fatal("owned file should already be removed")
	}
	if err := st.DB.Exec("DROP TRIGGER reject_cleanup").Error; err != nil {
		t.Fatal(err)
	}
	if err := m.RecoverInterruptedOperations(); err != nil {
		t.Fatal(err)
	}
	if rows, err := st.ListUploadArchives(); err != nil || len(rows) != 0 {
		t.Fatal("retry did not settle journal", err)
	}
}

func TestCompletedUploadHandleCannotDeleteUnregisteredReplacement(t *testing.T) {
	m, _, _ := localFixture(t)
	m.config.Storage.TempDir = t.TempDir()
	a, err := m.CreateUploadArchive("program.zip")
	if err != nil {
		t.Fatal(err)
	}
	a.File.Close()
	if err := a.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.Path, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := a.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(a.Path); err != nil || string(data) != "replacement" {
		t.Fatal("stale ownership removed replacement", err)
	}
}

func TestUploadTaskConflictStillReclaimsArchive(t *testing.T) {
	m, st, req := localFixture(t)
	m.config.Storage.TempDir = t.TempDir()
	app, err := m.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := m.TryLock(app.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	releaseUpload, err := m.TryLockUpload()
	if err != nil {
		t.Fatal(err)
	}
	a, err := m.CreateUploadArchive("program.zip")
	if err != nil {
		releaseUpload()
		t.Fatal(err)
	}
	a.File.Close()
	m.ProcessUploadComplete(app.ID, a, releaseUpload)
	deadline := time.Now().Add(3 * time.Second)
	for {
		rows, err := st.ListUploadArchives()
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 0 && !m.IsUploading() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("conflicting task leaked archive or upload lock")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := os.Stat(a.Path); !os.IsNotExist(err) {
		t.Fatal("conflicting task left staging file")
	}
	got, err := st.GetApp(app.ID)
	if err != nil || got.Status != app.Status {
		t.Fatal("conflicting task changed application", err)
	}
}

package store

import (
	"path/filepath"
	"testing"

	"github.com/stream-kit/orchestrator/internal/model"
)

func TestLegacyControlEpochMigrationIsDurableAndIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	st, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	record := &model.StreamSession{ID: "legacy", Revision: 7, HostID: 1, AppID: 2,
		State: "running", ControllerConnectionID: "a", AudioJSON: "{}", PolicyJSON: "{}", ConnectionsJSON: "{}"}
	if err := st.UpsertStreamSession(record); err != nil {
		t.Fatal(err)
	}
	// Recreate the old schema in this isolated test database.
	if err := st.DB.Migrator().DropColumn(&model.StreamSession{}, "ControlEpoch"); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = New(path)
	if err != nil {
		t.Fatal(err)
	}
	migrated, err := st.GetStreamSession("legacy")
	if err != nil {
		t.Fatal(err)
	}
	if migrated.ControlEpoch != 7 || migrated.ControllerConnectionID != "a" {
		t.Fatal("legacy authority was not migrated", migrated)
	}
	migrated.Revision = 12 // A heartbeat must not rewrite the generation at restart.
	if err := st.UpsertStreamSession(migrated); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	after, err := st.GetStreamSession("legacy")
	if err != nil {
		t.Fatal(err)
	}
	if after.ControlEpoch != 7 || after.Revision != 12 {
		t.Fatal("migration changed an existing generation")
	}
}

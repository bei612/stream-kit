package store

import (
	"path/filepath"
	"testing"

	"github.com/stream-kit/orchestrator/internal/model"
)

func TestApplicationSourceMigrationAndReopen(t *testing.T) {
	file := filepath.Join(t.TempDir(), "apps.sqlite")
	st, err := New(file)
	if err != nil {
		t.Fatal(err)
	}
	record := &model.App{ID: "old", Name: "Old upload", Status: model.AppStatusReady}
	if err = st.CreateApp(record); err != nil {
		t.Fatal(err)
	}
	// Recreate the pre-source schema in this disposable test database.
	if err = st.DB.Migrator().DropColumn(&model.App{}, "Source"); err != nil {
		t.Fatal(err)
	}
	if err = st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = New(file)
	if err != nil {
		t.Fatal(err)
	}
	old, err := st.GetApp("old")
	if err != nil || old.Source != model.AppSourceArchive {
		t.Fatalf("old source: %+v %v", old, err)
	}
	if err = st.CreateApp(&model.App{ID: "local", Name: "Existing program", Source: model.AppSourceLocal, Status: model.AppStatusReady, ExePath: "external", AppDir: "owned"}); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
	st, err = New(file)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	local, err := st.GetApp("local")
	if err != nil || local.Source != model.AppSourceLocal || local.ExePath != "external" || local.AppDir != "owned" {
		t.Fatalf("local source: %+v %v", local, err)
	}
}

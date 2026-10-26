package store

import (
	"testing"

	"github.com/stream-kit/orchestrator/internal/model"
	"gorm.io/gorm"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := New(":memory:")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func makeApp(id, name string) *model.App {
	return &model.App{
		ID:              id,
		Name:            name,
		Status:          model.AppStatusUploading,
		SunshineAppName: name,
	}
}

// --- App CRUD ---

func TestCreateAndGetApp(t *testing.T) {
	st := newTestStore(t)
	app := makeApp("test-1", "MyApp")
	if err := st.CreateApp(app); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetApp("test-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "MyApp" || got.Status != model.AppStatusUploading {
		t.Errorf("got name=%s status=%s", got.Name, got.Status)
	}
}

func TestCreateApp_DuplicateName(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("a1", "SameName"))
	err := st.CreateApp(makeApp("a2", "SameName"))
	if err == nil {
		t.Error("expected unique constraint error, got nil")
	}
}

func TestListApps(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("a1", "App1"))
	st.CreateApp(makeApp("a2", "App2"))
	st.CreateApp(makeApp("a3", "App3"))
	apps, err := st.ListApps()
	if err != nil {
		t.Fatal(err)
	}
	if len(apps) != 3 {
		t.Errorf("expected 3, got %d", len(apps))
	}
}

func TestUpdateAppFields(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("u1", "Original"))
	st.UpdateAppFields("u1", map[string]interface{}{
		"exe_path": "/path/to/exe",
	})
	got, _ := st.GetApp("u1")
	if got.ExePath != "/path/to/exe" {
		t.Errorf("exe_path not updated: %s", got.ExePath)
	}
	if got.Name != "Original" {
		t.Error("name should not have changed")
	}
}

func TestDeleteApp(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("d1", "ToDelete"))
	if err := st.DeleteApp("d1"); err != nil {
		t.Fatal(err)
	}
	_, err := st.GetApp("d1")
	if err != gorm.ErrRecordNotFound {
		t.Errorf("expected not found, got %v", err)
	}
}

func TestGetAppByName(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("n1", "FindMe"))

	got, err := st.GetAppByName("FindMe")
	if err != nil || got == nil {
		t.Fatal("expected to find app")
	}
	if got.ID != "n1" {
		t.Errorf("wrong ID: %s", got.ID)
	}

	got2, err2 := st.GetAppByName("NotExist")
	if err2 != nil || got2 != nil {
		t.Error("expected nil,nil for missing name")
	}
}

// --- TransitionAppStatus CAS ---

func TestTransitionAppStatus_Success(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("cas1", "CAS"))
	err := st.TransitionAppStatus("cas1", model.AppStatusUploading, model.AppStatusExtracting, "")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := st.GetApp("cas1")
	if got.Status != model.AppStatusExtracting {
		t.Errorf("expected extracting, got %s", got.Status)
	}
}

func TestTransitionAppStatus_WrongFromState(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("cas2", "CAS2"))
	// Current is uploading, try to transition from extracting (wrong)
	err := st.TransitionAppStatus("cas2", model.AppStatusExtracting, model.AppStatusDetecting, "")
	if err == nil {
		t.Error("expected CAS failure, got nil")
	}
	got, _ := st.GetApp("cas2")
	if got.Status != model.AppStatusUploading {
		t.Errorf("status should not have changed, got %s", got.Status)
	}
}

func TestTransitionAppStatus_ErrorMessage(t *testing.T) {
	st := newTestStore(t)
	st.CreateApp(makeApp("cas3", "CAS3"))
	st.TransitionAppStatus("cas3", model.AppStatusUploading, model.AppStatusError, "something broke")
	got, _ := st.GetApp("cas3")
	if got.ErrorMessage != "something broke" {
		t.Errorf("error message not set: %s", got.ErrorMessage)
	}
}

// --- Operation Logs ---

func TestCreateAndQueryLog(t *testing.T) {
	st := newTestStore(t)
	st.CreateLog("app", "app-1", "upload", "success", "uploaded file", nil)
	result, err := st.QueryLogs(LogQuery{Page: 1, Size: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 {
		t.Errorf("expected 1 log, got %d", len(result.Items))
	}
	if result.Items[0].Operation != "upload" {
		t.Errorf("wrong operation: %s", result.Items[0].Operation)
	}
}

func TestQueryLogs_Pagination(t *testing.T) {
	st := newTestStore(t)
	for i := 0; i < 25; i++ {
		st.CreateLog("app", "a1", "op", "success", "msg", nil)
	}

	r1, _ := st.QueryLogs(LogQuery{Page: 1, Size: 10})
	if len(r1.Items) != 10 || r1.Total != 25 {
		t.Errorf("page 1: got %d items, total %d", len(r1.Items), r1.Total)
	}

	r3, _ := st.QueryLogs(LogQuery{Page: 3, Size: 10})
	if len(r3.Items) != 5 {
		t.Errorf("page 3: expected 5, got %d", len(r3.Items))
	}
}

func TestQueryLogs_Filter(t *testing.T) {
	st := newTestStore(t)
	st.CreateLog("app", "a1", "upload", "success", "m1", nil)
	st.CreateLog("component", "sun", "start", "success", "m2", nil)
	st.CreateLog("app", "a2", "delete", "success", "m3", nil)

	r, _ := st.QueryLogs(LogQuery{Page: 1, Size: 10, TargetType: "app"})
	if len(r.Items) != 2 {
		t.Errorf("expected 2 app logs, got %d", len(r.Items))
	}

	r2, _ := st.QueryLogs(LogQuery{Page: 1, Size: 10, Operation: "start"})
	if len(r2.Items) != 1 {
		t.Errorf("expected 1 start log, got %d", len(r2.Items))
	}
}

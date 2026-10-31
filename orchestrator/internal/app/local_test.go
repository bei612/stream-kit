package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

func localFixture(t *testing.T) (*Manager, *store.Store, LocalAppRequest) {
	t.Helper()
	root := t.TempDir()
	database := filepath.Join(root, "state.sqlite")
	st, err := store.New(database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := &config.Config{Storage: config.StorageConfig{AppsDir: filepath.Join(root, "managed")}, Templates: map[string]string{"windowed": "-windowed"}}
	folder := filepath.Join(root, "Original program")
	if err = os.Mkdir(folder, 0755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(folder, "Example app.exe")
	if err = os.WriteFile(exe, []byte("original program bytes"), 0755); err != nil {
		t.Fatal(err)
	}
	return NewManager(st, cfg, nil, nil, nil, zap.NewNop()), st, LocalAppRequest{Name: "Local example", ExePath: exe}
}
func requireSameLocalFile(t *testing.T, actual, expected string) {
	t.Helper()
	a, err := os.Stat(actual)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.Stat(expected)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(a, b) {
		t.Fatalf("different filesystem objects: %q and %q", actual, expected)
	}
}

func TestLocalApplicationPersistsAndDeletionPreservesOriginal(t *testing.T) {
	manager, st, req := localFixture(t)
	req.ArgsTemplate = "windowed"
	record, err := manager.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if record.Source != model.AppSourceLocal || record.Status != model.AppStatusReady || record.Args != "-windowed" || record.AppDir == record.WorkingDir {
		t.Fatalf("incorrect local model: %+v", record)
	}
	requireSameLocalFile(t, record.ExePath, req.ExePath)
	requireSameLocalFile(t, record.WorkingDir, filepath.Dir(req.ExePath))
	if programDirectory(record) != filepath.Dir(record.ExePath) {
		t.Fatal("app_dir substitution points at platform metadata")
	}
	_ = os.WriteFile(filepath.Join(record.AppDir, "output.log"), []byte("platform log"), 0600)
	saved, err := st.GetApp(record.ID)
	if err != nil || saved.Source != model.AppSourceLocal {
		t.Fatal("source not persisted")
	}
	if err = manager.DeleteApp(record.ID); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(req.ExePath)
	if err != nil || string(content) != "original program bytes" {
		t.Fatal("deleted or modified external program")
	}
	if _, err = os.Stat(record.AppDir); !os.IsNotExist(err) {
		t.Fatal("owned metadata not removed")
	}
	if _, err = st.GetApp(record.ID); err == nil {
		t.Fatal("registration retained")
	}
}
func TestLocalApplicationRejectsInvalidReferencesAndOwnedStorage(t *testing.T) {
	manager, st, req := localFixture(t)
	for _, test := range []struct {
		name   string
		change func(*LocalAppRequest)
	}{
		{"relative", func(r *LocalAppRequest) { r.ExePath = "app.exe" }},
		{"missing", func(r *LocalAppRequest) { r.ExePath += ".missing" }},
		{"directory", func(r *LocalAppRequest) { r.ExePath = filepath.Dir(r.ExePath) }},
		{"missing working directory", func(r *LocalAppRequest) { r.WorkingDir = filepath.Join(filepath.Dir(r.ExePath), "missing") }},
		{"name", func(r *LocalAppRequest) { r.Name = " " }},
		{"unknown template", func(r *LocalAppRequest) { r.ArgsTemplate = "missing" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			copy := req
			test.change(&copy)
			if _, err := manager.RegisterLocal(copy); err == nil {
				t.Fatal("invalid reference accepted")
			}
		})
	}
	_ = os.MkdirAll(manager.config.Storage.AppsDir, 0755)
	inside := filepath.Join(manager.config.Storage.AppsDir, "Owned.exe")
	_ = os.WriteFile(inside, []byte("keep"), 0755)
	copy := req
	copy.ExePath = inside
	if _, err := manager.RegisterLocal(copy); err == nil {
		t.Fatal("accepted reference into managed storage")
	}
	records, _ := st.ListApps()
	if len(records) != 0 {
		t.Fatal("invalid references persisted")
	}
}
func TestDeletionRefusesUnownedDirectoryBeforeChangingDatabase(t *testing.T) {
	manager, st, req := localFixture(t)
	record, err := manager.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err = st.UpdateAppFields(record.ID, map[string]interface{}{"app_dir": filepath.Dir(req.ExePath)}); err != nil {
		t.Fatal(err)
	}
	if err = manager.DeleteApp(record.ID); err == nil {
		t.Fatal("unowned directory accepted for deletion")
	}
	if _, err = st.GetApp(record.ID); err != nil {
		t.Fatal("removed authoritative record before ownership check")
	}
	if _, err = os.Stat(req.ExePath); err != nil {
		t.Fatal("external file removed")
	}
}
func TestMissingLocalProgramCannotLaunch(t *testing.T) {
	manager, _, req := localFixture(t)
	record, err := manager.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(req.ExePath); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.LaunchApp(record.ID); err == nil {
		t.Fatal("launched a missing local program")
	}
}
func TestProgramCommandQuotesPathAndEscapesSunshineSubstitutions(t *testing.T) {
	input := `C:\Program Files\$(literal)\app.exe`
	got := quoteProgram(input)
	if !strings.HasPrefix(got, `"`) || !strings.HasSuffix(got, `"`) || !strings.Contains(got, "$$(literal)") {
		t.Fatal(got)
	}
	if runtime.GOOS == "windows" && got != `"C:\Program Files\$$(literal)\app.exe"` {
		t.Fatal(got)
	}
}

func TestLocalRegistrationProjectsProgramAndOwnedPathsToSunshine(t *testing.T) {
	manager, _, req := localFixture(t)
	var registration sunshine.SunshineApp
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/stream-kit/capabilities":
			_, _ = w.Write([]byte(`{"schema_version":1,"capture_modes":["desktop","application"],"capture_mode_apply":"application_restart","managed_apps_version":1,"managed_runtime_version":1}`))
		case r.URL.Path == "/api/stream-kit/runtime":
			_ = json.NewEncoder(w).Encode(sunshine.Runtime{SchemaVersion: 1})
		case r.URL.Path == "/api/csrf-token":
			_, _ = w.Write([]byte(`{"csrf_token":"test"}`))
		case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/api/stream-kit/apps/"):
			if err := json.NewDecoder(r.Body).Decode(&registration); err != nil {
				t.Error(err)
			}
			id := strings.TrimPrefix(r.URL.Path, "/api/stream-kit/apps/")
			_ = json.NewEncoder(w).Encode(sunshine.ManagedApp{SchemaVersion: 1, AppID: id, GameStreamID: 771, App: registration})
		default:
			t.Errorf("unexpected native lifecycle request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	manager.sunClient = sunshine.NewClient(config.SunshineAPIConfig{BaseURL: server.URL}, zap.NewNop())
	req.Args = `--assets "{app_dir}"`
	req.CaptureMode = model.CaptureApplication
	record, err := manager.RegisterLocal(req)
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != model.AppStatusReady {
		t.Fatalf("registration: %+v", record)
	}
	if record.SunshineAppID != 771 || registration.ManagedID != record.ID {
		t.Fatalf("immutable encoder identity was not persisted: %+v", record)
	}
	if record.CaptureMode != model.CaptureApplication || registration.CaptureMode != model.CaptureApplication || registration.AutoDetach || !registration.WaitAll {
		t.Fatalf("capture scope not projected into tracked launch: %+v %+v", record, registration)
	}
	requireSameLocalFile(t, record.ExePath, req.ExePath)
	requireSameLocalFile(t, record.WorkingDir, filepath.Dir(req.ExePath))
	if registration.WorkingDir != record.WorkingDir || registration.Output != filepath.Join(record.AppDir, "output.log") || registration.ImagePath != filepath.Join(record.AppDir, "icon.png") {
		t.Fatalf("unified path projection: %+v", registration)
	}
	if registration.Cmd != `"`+record.ExePath+`" --assets "`+filepath.Dir(record.ExePath)+`"` {
		t.Fatal(registration.Cmd)
	}
	if _, err = os.Stat(filepath.Join(filepath.Dir(req.ExePath), "icon.png")); !os.IsNotExist(err) {
		t.Fatal("wrote icon into externally owned program directory")
	}
	name := "Renamed local program"
	if err := manager.UpdateApp(record.ID, &name, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	renamed, err := manager.store.GetApp(record.ID)
	if err != nil || renamed.SunshineAppID != 771 || registration.Name != name || registration.ManagedID != record.ID {
		t.Fatalf("rename replaced application identity: %+v %v", renamed, err)
	}
}

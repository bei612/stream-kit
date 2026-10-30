package handlers

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestConfigurationAPIWritesOnlyDesiredConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := []byte(`{"server":{"bind_address":"127.0.0.1:9000","username":"admin","password":"private-password"},"storage":{"apps_dir":"apps","temp_dir":"temp","db_path":"state.db","max_upload_size_bytes":1024,"max_extract_size_bytes":2048,"max_file_count":10},"process":{"monitor_interval_seconds":5}}`)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	oldBase := config.BaseDir
	defer func() { config.BaseDir = oldBase }()
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	h := NewSystemHandler(cfg, nil, nil, zap.NewNop())
	router := gin.New()
	router.GET("/configuration", h.Configuration)
	router.PATCH("/configuration", h.Configuration)
	call := func(method, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/configuration", strings.NewReader(body))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	initial := call("GET", "")
	if initial.Code != 200 || initial.Header().Get("Cache-Control") != "no-store" || strings.Contains(initial.Body.String(), "private-password") {
		t.Fatal("invalid configuration projection", initial.Code)
	}
	var snapshot struct {
		Data config.SettingsView `json:"data"`
	}
	if err := json.Unmarshal(initial.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(map[string]any{"revision": snapshot.Data.Revision, "changes": map[string]any{"/storage/max_file_count": 20}})
	saved := call("PATCH", string(request))
	if saved.Code != 200 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	if cfg.Storage.MaxFileCount != 10 || cfg.Server.Password != "private-password" {
		t.Fatal("mutated running config")
	}
	disk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(disk, []byte("private-password")) {
		t.Fatal("erased credential")
	}
	if stale := call("PATCH", string(request)); stale.Code != 409 {
		t.Fatal("stale revision accepted")
	}
	if bad := call("PATCH", `{"revision":"x","unexpected":true}`); bad.Code != 400 {
		t.Fatal("unknown request fields accepted")
	}
	loaded, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	view, err := config.NewSettings(loaded).View()
	if err != nil || view.RestartRequired || loaded.Storage.MaxFileCount != 20 {
		t.Fatal("restart did not apply desired settings", err)
	}
}

package handlers

import (
	"bytes"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

func TestLocalApplicationRejectsUnknownAndMultipleJSONBeforeMutation(t *testing.T) {
	router := gin.New()
	router.POST("/local", NewAppHandler(nil, nil, nil).RegisterLocal)
	for _, body := range []string{`{"name":"x","app_dir":"external"}`, `{"name":"x","source":"archive"}`, `{} {}`, `{`, string(bytes.Repeat([]byte(" "), 16385)) + `{}`} {
		request := httptest.NewRequest("POST", "/local", bytes.NewBufferString(body))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != 400 {
			t.Fatalf("untrusted body status %d", response.Code)
		}
	}
}

func TestApplicationUpdateOwnsItsDomainLock(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a := &model.App{ID: "update-test", Name: "Example", Status: model.AppStatusReady}
	if err := st.CreateApp(a); err != nil {
		t.Fatal(err)
	}
	m := app.NewManager(st, &config.Config{}, nil, nil, nil, zap.NewNop())
	router := gin.New()
	router.PATCH("/apps/:app_id", NewAppHandler(m, st, nil).Update)
	call := func(want int) {
		t.Helper()
		req := httptest.NewRequest("PATCH", "/apps/"+a.ID, bytes.NewBufferString(`{"args":"--updated"}`))
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("status %d want %d: %s", res.Code, want, res.Body.String())
		}
	}
	unlock, err := m.TryLock(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	call(409)
	unlock()
	call(200)
	saved, err := st.GetApp(a.ID)
	if err != nil || saved.Args != "--updated" {
		t.Fatal("update was not persisted", err)
	}
}

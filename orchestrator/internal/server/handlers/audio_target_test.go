package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/session"
)

func TestAudioTargetHTTPValidationAndCompareAndSet(t *testing.T) {
	m := session.NewManager(nil)
	s, _ := m.Ensure(1, 2)
	h := NewSessionHandler(m, nil)
	var validationError error
	h.ValidateAudioTarget = func(context.Context, session.AudioTarget) error { return validationError }
	router := gin.New()
	router.PATCH("/sessions/:session_id/audio-target", h.AudioTarget)
	call := func(body string, status int) {
		t.Helper()
		req := httptest.NewRequest("PATCH", "/sessions/"+s.ID+"/audio-target", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("status %d want %d: %s", rec.Code, status, rec.Body.String())
		}
	}
	for _, body := range []string{
		`{}`, `{"expected_epoch":1,"target":{"mode":"auto"}}`,
		`{"expected_epoch":1,"target":{"mode":"upstream","epoch":999}}`,
		`{"expected_epoch":1,"target":{"mode":"local","render_device_id":"same","capture_device_id":"same"}}`,
		`{"expected_epoch":1,"target":{"mode":"disabled"}} {}`,
	} {
		call(body, 400)
	}
	body := `{"expected_epoch":1,"target":{"mode":"local","render_device_id":"render","capture_device_id":"capture"}}`
	validationError = session.ErrInvalidState
	call(body, 400)
	validationError = errors.New("gateway down")
	call(body, 503)
	unchanged, _ := m.Get(s.ID)
	if unchanged.Revision != s.Revision {
		t.Fatal("failed validation committed intent")
	}
	validationError = nil
	call(body, 200)
	committed, _ := m.Get(s.ID)
	if committed.Audio.Target.Mode != "local" || committed.Audio.Target.Epoch != committed.Revision {
		t.Fatal("target not committed")
	}
	call(body, 409)
	// Simulate another administrator command while native validation runs.
	h.ValidateAudioTarget = func(context.Context, session.AudioTarget) error {
		return m.UpdateAudioTarget(s.ID, committed.Audio.Target.Epoch, session.AudioTarget{Mode: "disabled"})
	}
	next, _ := json.Marshal(map[string]any{"expected_epoch": committed.Audio.Target.Epoch, "target": map[string]string{"mode": "upstream"}})
	call(string(next), 409)
	after, _ := m.Get(s.ID)
	if after.Audio.Target.Mode != "disabled" {
		t.Fatal("validation race overwrote new intent")
	}
}

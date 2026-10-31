package handlers

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/session"
)

func TestAudioHTTPRequiresCurrentConfiguration(t *testing.T) {
	m := session.NewManager(nil)
	s, _ := m.Ensure(1, 2)
	router := gin.New()
	router.PATCH("/sessions/:session_id/audio", NewSessionHandler(m, nil).Audio)
	next := s.Audio
	next.MicrophoneEnabled = false
	for _, tc := range []struct {
		expected *session.AudioConfig
		status   int
	}{{nil, 400}, {&s.Audio, 200}, {&s.Audio, 409}} {
		body, _ := json.Marshal(struct {
			session.AudioConfig
			Expected *session.AudioConfig `json:"expected_audio"`
		}{next, tc.expected})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest("PATCH", "/sessions/"+s.ID+"/audio", bytes.NewReader(body)))
		if recorder.Code != tc.status {
			t.Fatalf("status=%d want=%d body=%s", recorder.Code, tc.status, recorder.Body.String())
		}
	}
}

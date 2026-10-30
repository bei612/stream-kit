package handlers

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/session"
)

func TestTransferEndpointRequiresExplicitExpectedController(t *testing.T) {
	gin.SetMode(gin.TestMode)
	m := session.NewManager(nil)
	s, _ := m.Ensure(1, 2)
	a, _ := m.AddConnection(s.ID, "a")
	b, _ := m.AddConnection(s.ID, "b")
	_ = m.Claim(s.ID, a.ID)
	h := NewSessionHandler(m, []byte("secret"))
	router := gin.New()
	router.PUT("/:session_id/controller/:connection_id", h.Transfer)
	for _, test := range []struct {
		body   string
		status int
	}{
		{`{}`, http.StatusBadRequest},
		{`{"expected_controller_connection_id":"stale"}`, http.StatusConflict},
		{`{"expected_controller_connection_id":"` + a.ID + `"}`, http.StatusOK},
		{`{"expected_controller_connection_id":"` + a.ID + `"}`, http.StatusConflict},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPut, "/"+s.ID+"/controller/"+b.ID, bytes.NewBufferString(test.body))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		if recorder.Code != test.status {
			t.Fatalf("status %d, want %d", recorder.Code, test.status)
		}
	}
	current, _ := m.Get(s.ID)
	if current.ControllerConnectionID != b.ID {
		t.Fatal("controller not transferred")
	}
}

func TestMediaTicketRequiresGatewayAcknowledgement(t *testing.T) {
	gin.SetMode(gin.TestMode)
	m := session.NewManager(nil)
	s, _ := m.Ensure(1, 2)
	c, _ := m.AddConnection(s.ID, "client")
	h := NewSessionHandler(m, []byte("secret"))
	router := gin.New()
	router.POST("/:session_id/connections/:connection_id/ticket", h.MediaTicket)
	for _, test := range []struct {
		sync   func(context.Context) error
		status int
	}{
		{nil, http.StatusServiceUnavailable},
		{func(context.Context) error { return errors.New("offline") }, http.StatusServiceUnavailable},
		{func(context.Context) error { return nil }, http.StatusOK},
	} {
		h.SyncMedia = test.sync
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/"+s.ID+"/connections/"+c.ID+"/ticket", nil))
		if recorder.Code != test.status {
			t.Fatalf("status %d, want %d", recorder.Code, test.status)
		}
	}
}

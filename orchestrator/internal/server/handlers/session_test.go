package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/session"
)

func TestBothViewingEntrypointsUseApplicationAdmission(t *testing.T) {
	m := session.NewManager(nil)
	h := NewSessionHandler(m, []byte("secret"))
	calls := 0
	h.EnsureViewingSession = func(ctx context.Context, host, app int64) (*session.RenderSession, error) {
		calls++
		if host != 1 || app != 2 {
			t.Fatal("admission identity changed")
		}
		return nil, session.ErrNotFound
	}
	h.SyncMedia = func(context.Context) error { return nil }
	client := NewClientSessionHandler(h, []byte("secret"))
	router := gin.New()
	router.POST("/ensure", h.Ensure)
	router.POST("/invite", client.Invite)
	for _, path := range []string{"/ensure", "/invite"} {
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{"host_id":1,"app_id":2}`))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s bypassed admission: %d", path, recorder.Code)
		}
	}
	if calls != 2 || len(m.List()) != 0 {
		t.Fatal("admission rejection created a session")
	}
}

func TestTransferEndpointRequiresExplicitExpectedController(t *testing.T) {
	gin.SetMode(gin.TestMode)
	m := session.NewManager(nil)
	s, _ := m.Ensure(1, 2)
	a, _ := m.AddConnection(s.ID, "a")
	b, _ := m.AddConnection(s.ID, "b")
	_ = m.Claim(s.ID, a.ID)
	observed, _ := m.Get(s.ID)
	h := NewSessionHandler(m, []byte("secret"))
	router := gin.New()
	router.PUT("/:session_id/controller/:connection_id", h.Transfer)
	for _, test := range []struct {
		body   string
		status int
	}{
		{`{}`, http.StatusBadRequest},
		{`{"expected_controller_connection_id":"stale"}`, http.StatusBadRequest},
		{fmt.Sprintf(`{"expected_controller_connection_id":"stale","expected_control_epoch":%d}`, observed.ControlEpoch), http.StatusConflict},
		{fmt.Sprintf(`{"expected_controller_connection_id":"%s","expected_control_epoch":%d}`, a.ID, observed.ControlEpoch), http.StatusOK},
		{fmt.Sprintf(`{"expected_controller_connection_id":"%s","expected_control_epoch":%d}`, a.ID, observed.ControlEpoch), http.StatusConflict},
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

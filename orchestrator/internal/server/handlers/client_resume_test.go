package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/session"
)

func TestClientResumeCredentialIsolationAndExplicitRevocation(t *testing.T) {
	m := session.NewManager(nil)
	s, err := m.Ensure(1, 2)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := m.AddConnection(s.ID, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SweepExpired(time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	h := NewSessionHandler(m, []byte("secret"))
	client := NewClientSessionHandler(h, []byte("secret"))
	r := gin.New()
	route := "/:session_id/connections/:connection_id"
	r.POST(route+"/resume", client.Resume)
	r.DELETE(route, client.Authorize(), h.Disconnect)
	r.GET(route, client.Authorize(), client.Current)
	now := time.Now()
	claims := identity.Claims{Subject: "owner", SessionID: s.ID, ConnectionID: conn.ID, IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix()}
	valid := identity.Sign(identity.Connection, claims, client.connectionKey)
	request := func(method, suffix, token string, want int) {
		t.Helper()
		req := httptest.NewRequest(method, "/"+s.ID+"/connections/"+conn.ID+suffix, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		r.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, suffix, res.Code, want, res.Body.String())
		}
		if want == http.StatusOK && suffix == "/resume" {
			var response struct {
				Data struct {
					Revision     *uint64 `json:"revision"`
					ControlEpoch *uint64 `json:"control_epoch"`
				} `json:"data"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			current, err := m.Get(s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if response.Data.Revision == nil || response.Data.ControlEpoch == nil ||
				*response.Data.Revision != current.Revision || *response.Data.ControlEpoch != current.ControlEpoch {
				t.Fatalf("resume omitted or changed authoritative versions: %s", res.Body.String())
			}
		}
	}
	request(http.MethodGet, "", valid, 410)
	request(http.MethodPost, "/resume", identity.Sign(identity.Invitation, claims, client.invitationKey), 401)
	wrong := claims
	wrong.ConnectionID = "other"
	request(http.MethodPost, "/resume", identity.Sign(identity.Connection, wrong, client.connectionKey), 401)
	wrong = claims
	wrong.Subject = "other"
	request(http.MethodPost, "/resume", identity.Sign(identity.Connection, wrong, client.connectionKey), 410)
	wrong = claims
	wrong.ExpiresAt = now.Add(-time.Second).Unix()
	request(http.MethodPost, "/resume", identity.Sign(identity.Connection, wrong, client.connectionKey), 401)
	request(http.MethodPost, "/resume", valid, 200)
	if _, err := m.SweepExpired(time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	request(http.MethodDelete, "", valid, 200)
	request(http.MethodPost, "/resume", valid, 410)
}

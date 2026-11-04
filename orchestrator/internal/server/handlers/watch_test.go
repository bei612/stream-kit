package handlers

import (
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/store"
	"net/http/httptest"
	"testing"
)

type watchLaunchFunc func(string) (string, error)

func (f watchLaunchFunc) LaunchApp(id string) (string, error) { return f(id) }

func TestWatchOpenUsesScopedViewerAdmissionAndRevocation(t *testing.T) {
	st, err := store.New(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	st.CreateApp(&model.App{ID: "app-a", Name: "A", Args: "--demo saved"})
	key, err := st.PublishWatchLink("app-a", false)
	if err != nil {
		t.Fatal(err)
	}
	manager := session.NewManager(nil)
	sh := NewSessionHandler(manager, []byte("test media key"))
	sh.SyncMedia = func(context.Context) error { return nil }
	clients := NewClientSessionHandler(sh, []byte("test management key"))
	calls := 0
	rotateDuringLaunch := false
	h := NewWatchHandler(st, watchLaunchFunc(func(id string) (string, error) {
		calls++
		if id != "app-a" {
			t.Fatal("wrong application")
		}
		if rotateDuringLaunch {
			st.PublishWatchLink(id, true)
		}
		return "8080/stream.html?hostId=7&appId=8", nil
	}), clients)
	router := gin.New()
	router.POST("/open", h.Open)
	router.POST("/join", clients.Join)
	request := func(path, token string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		return w
	}
	request("/open", "invalid", 401)
	if calls != 0 {
		t.Fatal("invalid link launched app")
	}
	opened := request("/open?args=attacker&appId=99", key, 200)
	if opened.Header().Get("X-Stream-Port") != "8080" {
		t.Fatal("missing gateway port")
	}
	var invitation struct {
		Data ViewingInvitation `json:"data"`
	}
	json.Unmarshal(opened.Body.Bytes(), &invitation)
	if invitation.Data.HostID != 7 || invitation.Data.AppID != 8 {
		t.Fatal("query changed link target")
	}
	joined := request("/join", invitation.Data.Invitation, 200)
	var conn struct {
		Data ClientConnectionState `json:"data"`
	}
	json.Unmarshal(joined.Body.Bytes(), &conn)
	if conn.Data.Connection == nil || conn.Data.Connection.Role != "viewer" {
		t.Fatal("link granted control")
	}
	if _, err := VerifyJWT(key, []byte("test management key")); err == nil {
		t.Fatal("watch capability accepted as management token")
	}
	request("/join", key, 401)
	saved, _ := st.GetApp("app-a")
	if saved.Args != "--demo saved" {
		t.Fatal("viewer changed startup arguments")
	}
	request("/open", key, 200) // repeat use has no one-shot semantics
	rotateDuringLaunch = true
	request("/open", key, 401)
	before := calls
	request("/open", key, 401)
	if calls != before {
		t.Fatal("revoked link launched app")
	}
}

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
)

func TestManagementWebSocketCredentialBoundaryAndLifetime(t *testing.T) {
	key := []byte("isolated-websocket-test-secret")
	hub := ws.NewHub(zap.NewNop())
	defer hub.Close()
	router := gin.New()
	handler := handlers.NewWSHandler(hub, zap.NewNop())
	router.GET("/api/v1/ws", JWTAuthMiddleware(key), handler.Handle)
	router.GET("/private", JWTAuthMiddleware(key), func(c *gin.Context) { c.Status(200) })
	server := httptest.NewServer(router)
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws"
	claims := handlers.Claims{Sub: "admin", Iat: time.Now().Unix() - 1, Exp: time.Now().Unix() + 60}
	token := identity.Sign(identity.Management, claims, key)
	protocols := []string{ws.Subprotocol, ws.CredentialPrefix + token}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, tc := range []struct {
		name, query, origin string
		protocols           []string
		status              int
	}{
		{"URL credential", "?token=" + token, "", nil, 401},
		{"no version", "", "", protocols[1:], 401},
		{"duplicate credentials", "", "", append(append([]string{}, protocols...), protocols[1]), 401},
		{"viewer credential", "", "", []string{ws.Subprotocol, ws.CredentialPrefix + identity.Sign(identity.Connection, claims, key)}, 401},
		{"untrusted origin", "", "https://untrusted.example", protocols, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := http.Header{}
			if tc.origin != "" {
				headers.Set("Origin", tc.origin)
			}
			conn, response, err := websocket.Dial(ctx, url+tc.query, &websocket.DialOptions{Subprotocols: tc.protocols, HTTPHeader: headers})
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != tc.status {
				t.Fatalf("expected HTTP %d rejection", tc.status)
			}
		})
	}
	// Upgrade credentials are not a second authentication mechanism for REST.
	req, _ := http.NewRequest("GET", server.URL+"/private", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Protocol", strings.Join(protocols, ","))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("upgrade bearer escaped WS endpoint")
	}
	conn, response, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: protocols})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != ws.Subprotocol || response.Header.Get("Sec-WebSocket-Protocol") != ws.Subprotocol {
		t.Fatal("credential echoed or protocol not negotiated")
	}
	waitCount(t, hub, 1)
	hub.Broadcast(ws.Event{Type: "stream_controller_changed", Data: "connection-a"})
	_, message, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var event ws.Event
	if json.Unmarshal(message, &event) != nil || event.Type != "stream_controller_changed" {
		t.Fatal("event missing")
	}
	conn.CloseNow()
	waitCount(t, hub, 0)

	claims.Exp = time.Now().Unix() + 2
	expiring := identity.Sign(identity.Management, claims, key)
	conn, _, err = websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{ws.Subprotocol, ws.CredentialPrefix + expiring}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_, _, err = conn.Read(ctx)
	if err == nil || ctx.Err() != nil {
		t.Fatal("server did not close at management credential expiry")
	}
	waitCount(t, hub, 0)
}

func waitCount(t *testing.T, hub *ws.Hub, count int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub.ClientCount() == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("hub client count %d, want %d", hub.ClientCount(), count)
}

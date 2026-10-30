package handlers

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
)

const ManagementExpiresAt = "management_expires_at"

type WSHandler struct {
	Hub    *ws.Hub
	Logger *zap.Logger
}

func NewWSHandler(hub *ws.Hub, logger *zap.Logger) *WSHandler {
	return &WSHandler{
		Hub:    hub,
		Logger: logger,
	}
}

func (h *WSHandler) Handle(c *gin.Context) {
	// JWT already validated by middleware (ws is under authed group)
	expiresAt := time.Unix(c.GetInt64(ManagementExpiresAt), 0)
	if !expiresAt.After(time.Now()) {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{Subprotocols: []string{ws.Subprotocol}})
	if err != nil {
		h.Logger.Warn("WebSocket 升级失败", zap.Error(err))
		return
	}

	client := ws.NewClient()
	if !h.Hub.Register(client) {
		conn.Close(websocket.StatusTryAgainLater, "Connection capacity reached")
		return
	}
	defer h.Hub.Unregister(client)
	defer conn.CloseNow()

	ctx, cancel := context.WithDeadline(c.Request.Context(), expiresAt)
	defer cancel()

	// Writer goroutine
	go func() {
		defer func() {
			cancel()
			conn.CloseNow()
		}()
		for {
			select {
			case msg, ok := <-client.Events():
				if !ok {
					return
				}
				ctx2, c2 := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(ctx2, websocket.MessageText, msg)
				c2()
				if err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// Reader goroutine (just keep connection alive, discard messages)
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			break
		}
	}
}

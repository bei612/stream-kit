package handlers

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
)

type WSHandler struct {
	Hub       *ws.Hub
	Logger    *zap.Logger
	JWTSecret []byte

	GetSnapshot func() interface{}
}

func NewWSHandler(hub *ws.Hub, jwtSecret []byte, logger *zap.Logger) *WSHandler {
	return &WSHandler{
		Hub:       hub,
		Logger:    logger,
		JWTSecret: jwtSecret,
	}
}

func (h *WSHandler) Handle(c *gin.Context) {
	// JWT already validated by middleware (ws is under authed group)
	conn, err := websocket.Accept(c.Writer, c.Request, nil)
	if err != nil {
		h.Logger.Warn("WebSocket 升级失败", zap.Error(err))
		return
	}

	client := &ws.ClientConn{
		Send: make(chan []byte, 64),
	}
	h.Hub.Register(client)

	// Send initial snapshot if available
	if h.GetSnapshot != nil {
		snapshot := h.GetSnapshot()
		if data, err := json.Marshal(ws.Event{Type: "full_snapshot", Data: snapshot}); err == nil {
			select {
			case client.Send <- data:
			default:
			}
		}
	}

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	// Writer goroutine
	go func() {
		defer func() {
			h.Hub.Unregister(client)
			conn.Close(websocket.StatusNormalClosure, "")
		}()
		for {
			select {
			case msg, ok := <-client.Send:
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

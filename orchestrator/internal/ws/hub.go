package ws

import (
	"encoding/json"
	"sync"

	"github.com/stream-kit/orchestrator/internal/util"
	"go.uber.org/zap"
)

const MaxClients = 20

type Event struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

type Hub struct {
	clients    map[*ClientConn]bool
	broadcast  chan Event
	register   chan *ClientConn
	unregister chan *ClientConn
	mu         sync.RWMutex
	logger     *zap.Logger
}

type ClientConn struct {
	Send chan []byte
	Hub  *Hub
}

func NewHub(logger *zap.Logger) *Hub {
	h := &Hub{
		clients:    make(map[*ClientConn]bool),
		broadcast:  make(chan Event, 256),
		register:   make(chan *ClientConn),
		unregister: make(chan *ClientConn),
		logger:     logger,
	}
	util.SafeGo(logger, "ws-hub", h.run)
	return h
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if len(h.clients) >= MaxClients {
				h.mu.Unlock()
				close(client.Send)
				continue
			}
			h.clients[client] = true
			h.mu.Unlock()
			h.logger.Debug("WebSocket 客户端已连接", zap.Int("total", h.ClientCount()))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.Send)
			}
			h.mu.Unlock()
			h.logger.Debug("WebSocket 客户端已断开", zap.Int("total", h.ClientCount()))

		case event := <-h.broadcast:
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.Send <- data:
				default:
					// Client too slow, disconnect
					go func(c *ClientConn) {
						h.unregister <- c
					}(client)
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) Register(client *ClientConn) {
	h.register <- client
}

func (h *Hub) Unregister(client *ClientConn) {
	h.unregister <- client
}

func (h *Hub) Broadcast(event Event) {
	select {
	case h.broadcast <- event:
	default:
		// Broadcast channel full, drop event
		h.logger.Warn("WebSocket 广播队列已满，丢弃事件", zap.String("type", event.Type))
	}
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

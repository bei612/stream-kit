package ws

import (
	"encoding/json"
	"sync"

	"go.uber.org/zap"
)

const MaxClients = 20

type Event struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

type Hub struct {
	clients map[*ClientConn]bool
	closed  bool
	mu      sync.RWMutex
	logger  *zap.Logger
}

type ClientConn struct {
	send chan []byte
}

func NewClient() *ClientConn                { return &ClientConn{send: make(chan []byte, 64)} }
func (c *ClientConn) Events() <-chan []byte { return c.send }

func NewHub(logger *zap.Logger) *Hub {
	return &Hub{
		clients: make(map[*ClientConn]bool),
		logger:  logger,
	}
}

// Membership and channel closure have one owner: the hub lock. With at most
// MaxClients bounded queues, fanout is synchronous and never waits for readers.
func (h *Hub) Register(client *ClientConn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if client == nil || client.send == nil || h.closed || len(h.clients) >= MaxClients || h.clients[client] {
		return false
	}
	h.clients[client] = true
	return true
}

func (h *Hub) Unregister(client *ClientConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[client] {
		delete(h.clients, client)
		close(client.send)
	}
}

func (h *Hub) Broadcast(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		select {
		case client.send <- data:
		default:
			delete(h.clients, client)
			close(client.send)
			h.logger.Debug("WebSocket 慢连接已关闭")
		}
	}
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for client := range h.clients {
		delete(h.clients, client)
		close(client.send)
	}
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

package ws

import (
	"sync"
	"testing"

	"go.uber.org/zap"
)

func TestBoundedFanoutAndClosure(t *testing.T) {
	hub := NewHub(zap.NewNop())
	slow := &ClientConn{send: make(chan []byte, 1)}
	fast := &ClientConn{send: make(chan []byte, 4)}
	if !hub.Register(slow) || !hub.Register(fast) {
		t.Fatal("registration failed")
	}
	hub.Broadcast(Event{Type: "first"})
	hub.Broadcast(Event{Type: "second"})
	if hub.ClientCount() != 1 {
		t.Fatal("slow client not evicted synchronously")
	}
	<-slow.Events()
	if _, open := <-slow.Events(); open {
		t.Fatal("slow queue not closed")
	}
	if len(fast.Events()) != 2 {
		t.Fatal("healthy client lost events")
	}
	hub.Unregister(slow) // repeated close is harmless
	hub.Close()
	hub.Close()
	if hub.Register(&ClientConn{send: make(chan []byte, 1)}) {
		t.Fatal("closed hub accepted a connection")
	}
	hub.Broadcast(Event{Type: "late"})
}

func TestHubCapacityAndConcurrentOwnership(t *testing.T) {
	hub := NewHub(zap.NewNop())
	defer hub.Close()
	clients := make([]*ClientConn, MaxClients)
	for i := range clients {
		clients[i] = &ClientConn{send: make(chan []byte, 2)}
		if !hub.Register(clients[i]) {
			t.Fatal("premature capacity rejection")
		}
	}
	if hub.Register(&ClientConn{send: make(chan []byte, 1)}) {
		t.Fatal("capacity limit bypassed")
	}
	var workers sync.WaitGroup
	for _, client := range clients {
		workers.Add(1)
		go func(c *ClientConn) { defer workers.Done(); hub.Broadcast(Event{Type: "concurrent"}); hub.Unregister(c) }(client)
	}
	workers.Wait()
	if hub.ClientCount() != 0 {
		t.Fatal("connection leaked")
	}
}

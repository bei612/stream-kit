package component

import (
	"sync"
)

type RingBuffer struct {
	lines []string
	size  int
	head  int
	count int
	mu    sync.RWMutex
	subs  []chan string
	subMu sync.Mutex
}

func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		lines: make([]string, size),
		size:  size,
	}
}

func (rb *RingBuffer) Write(line string) {
	rb.mu.Lock()
	rb.lines[rb.head] = line
	rb.head = (rb.head + 1) % rb.size
	if rb.count < rb.size {
		rb.count++
	}
	rb.mu.Unlock()

	// Notify subscribers (non-blocking)
	rb.subMu.Lock()
	active := make([]chan string, 0, len(rb.subs))
	for _, ch := range rb.subs {
		select {
		case ch <- line:
			active = append(active, ch)
		default:
			// Subscriber too slow, drop and remove
			close(ch)
		}
	}
	rb.subs = active
	rb.subMu.Unlock()
}

func (rb *RingBuffer) GetLast(n int) []string {
	rb.mu.RLock()
	defer rb.mu.RUnlock()

	if n > rb.count {
		n = rb.count
	}
	result := make([]string, n)
	start := (rb.head - n + rb.size) % rb.size
	for i := 0; i < n; i++ {
		result[i] = rb.lines[(start+i)%rb.size]
	}
	return result
}

func (rb *RingBuffer) Subscribe() <-chan string {
	ch := make(chan string, 100)
	rb.subMu.Lock()
	rb.subs = append(rb.subs, ch)
	rb.subMu.Unlock()
	return ch
}

func (rb *RingBuffer) Unsubscribe(ch chan string) {
	rb.subMu.Lock()
	defer rb.subMu.Unlock()
	for i, sub := range rb.subs {
		if sub == ch {
			rb.subs = append(rb.subs[:i], rb.subs[i+1:]...)
			return
		}
	}
}

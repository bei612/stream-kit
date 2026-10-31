package component

import (
	"sync"
)

const maxComponentLogBytes = 4 * 1024 * 1024

type RingBuffer struct {
	lines []string
	size  int
	head  int
	count int
	bytes int
	mu    sync.RWMutex
	subs  []chan string
	subMu sync.Mutex
}

func NewRingBuffer(size int) *RingBuffer {
	if size < 1 {
		size = 1
	}
	return &RingBuffer{
		lines: make([]string, size),
		size:  size,
	}
}

func (rb *RingBuffer) Write(line string) {
	if len(line) > maxComponentLogLine {
		const suffix = " [line truncated]"
		line = line[:maxComponentLogLine-len(suffix)] + suffix
	}
	rb.mu.Lock()
	for rb.count > 0 && (rb.count == rb.size || rb.bytes+len(line) > maxComponentLogBytes) {
		oldest := (rb.head - rb.count + rb.size) % rb.size
		rb.bytes -= len(rb.lines[oldest])
		rb.lines[oldest] = ""
		rb.count--
	}
	rb.lines[rb.head] = line
	rb.bytes += len(line)
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
	if n <= 0 {
		return []string{}
	}

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

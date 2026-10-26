package component

import (
	"testing"
	"time"
)

func TestRingBuffer_Empty(t *testing.T) {
	rb := NewRingBuffer(5)
	got := rb.GetLast(10)
	if len(got) != 0 {
		t.Errorf("expected empty, got %d items", len(got))
	}
}

func TestRingBuffer_WriteThenRead(t *testing.T) {
	rb := NewRingBuffer(5)
	rb.Write("a")
	rb.Write("b")
	rb.Write("c")
	got := rb.GetLast(3)
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("expected [a b c], got %v", got)
	}
}

func TestRingBuffer_ClampToCount(t *testing.T) {
	rb := NewRingBuffer(5)
	rb.Write("a")
	rb.Write("b")
	got := rb.GetLast(10)
	if len(got) != 2 {
		t.Errorf("expected 2 (clamped), got %d", len(got))
	}
}

func TestRingBuffer_Overflow(t *testing.T) {
	rb := NewRingBuffer(3)
	rb.Write("a")
	rb.Write("b")
	rb.Write("c")
	rb.Write("d")
	rb.Write("e")
	got := rb.GetLast(3)
	if len(got) != 3 || got[0] != "c" || got[1] != "d" || got[2] != "e" {
		t.Errorf("expected [c d e] after overflow, got %v", got)
	}
}

func TestRingBuffer_GetLast0(t *testing.T) {
	rb := NewRingBuffer(5)
	rb.Write("a")
	got := rb.GetLast(0)
	if len(got) != 0 {
		t.Errorf("GetLast(0) should return empty, got %d", len(got))
	}
}

func TestRingBuffer_GetLast1AfterOverflow(t *testing.T) {
	rb := NewRingBuffer(3)
	for i := 0; i < 10; i++ {
		rb.Write("line")
	}
	got := rb.GetLast(1)
	if len(got) != 1 || got[0] != "line" {
		t.Errorf("expected [line], got %v", got)
	}
}

func TestRingBuffer_Subscribe(t *testing.T) {
	rb := NewRingBuffer(5)
	ch := rb.Subscribe()
	rb.Write("hello")

	select {
	case msg := <-ch:
		if msg != "hello" {
			t.Errorf("expected 'hello', got %q", msg)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("subscriber did not receive message")
	}
}

func TestRingBuffer_MultipleSubscribers(t *testing.T) {
	rb := NewRingBuffer(5)
	ch1 := rb.Subscribe()
	ch2 := rb.Subscribe()
	rb.Write("msg")

	for _, ch := range []<-chan string{ch1, ch2} {
		select {
		case msg := <-ch:
			if msg != "msg" {
				t.Errorf("expected 'msg', got %q", msg)
			}
		case <-time.After(100 * time.Millisecond):
			t.Error("subscriber did not receive message")
		}
	}
}

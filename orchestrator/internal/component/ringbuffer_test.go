package component

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stream-kit/orchestrator/internal/workeripc"
)

func TestRingBufferPublishesBoundedUTF8ToWorkerProtocol(t *testing.T) {
	for _, source := range []string{
		strings.Repeat("界", maxComponentLogLine/3+1),
		strings.Repeat("\xffx", maxComponentLogLine/2),
		strings.Repeat("\x00", maxComponentLogLine),
	} {
		rb := NewRingBuffer(1)
		ch := rb.Subscribe()
		rb.Write(source)
		line := <-ch
		if !utf8.ValidString(line) || len(line) > maxComponentLogLine || line != rb.GetLast(1)[0] {
			t.Fatal("stored and published logs must be identical bounded UTF-8")
		}
		const instance = "0123456789abcdef0123456789abcdef"
		writer, _ := workeripc.New(instance, workeripc.Events)
		reader, _ := workeripc.New(instance, workeripc.Events)
		var wire bytes.Buffer
		if err := writer.Write(&wire, workeripc.Frame{Kind: "log", Line: line}); err != nil {
			t.Fatal(err)
		}
		frame, err := reader.Read(&wire)
		if err != nil || frame.Line != line {
			t.Fatalf("worker log round trip: %v", err)
		}
	}
}

func TestRingBufferByteBudgetEvictsOldestWithoutLeavingReferences(t *testing.T) {
	rb := NewRingBuffer(1000)
	for i := 0; i < 200; i++ {
		rb.Write(fmt.Sprintf("%03d", i) + strings.Repeat("x", maxComponentLogLine-3))
	}
	lines := rb.GetLast(1000)
	if len(lines) != maxComponentLogBytes/maxComponentLogLine || rb.bytes > maxComponentLogBytes {
		t.Fatalf("lines=%d bytes=%d", len(lines), rb.bytes)
	}
	if !strings.HasPrefix(lines[0], "136") || !strings.HasPrefix(lines[len(lines)-1], "199") {
		t.Fatal("wrong eviction order")
	}
	retained := 0
	for _, line := range rb.lines {
		retained += len(line)
	}
	if retained != rb.bytes {
		t.Fatal("evicted strings still retained")
	}
	rb.Write("tail")
	if got := rb.GetLast(1); len(got) != 1 || got[0] != "tail" {
		t.Fatal("tail missing")
	}
}

func TestRingBufferBoundsPublishedLinesAndInvalidReadCounts(t *testing.T) {
	rb := NewRingBuffer(0)
	ch := rb.Subscribe()
	rb.Write(strings.Repeat("x", maxComponentLogLine*2))
	line := <-ch
	if len(line) != maxComponentLogLine || !strings.HasSuffix(line, " [line truncated]") {
		t.Fatal("subscriber received unbounded line")
	}
	if got := rb.GetLast(-1); len(got) != 0 {
		t.Fatal("negative count was not empty")
	}
	rb.Write("next")
	if got := rb.GetLast(10); len(got) != 1 || got[0] != "next" {
		t.Fatal("minimum capacity incorrect")
	}
}

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

package component

import (
	"errors"
	"sync/atomic"
	"testing"
)

type testProcessBackend struct {
	exited     chan struct{}
	code       int
	err        error
	graceful   bool
	killError  error
	interrupts atomic.Int32
	kills      atomic.Int32
}

func (p *testProcessBackend) wait() (int, error) { <-p.exited; return p.code, p.err }
func (p *testProcessBackend) interrupt() error {
	p.interrupts.Add(1)
	if p.graceful {
		close(p.exited)
	}
	return nil
}
func (p *testProcessBackend) kill() error {
	p.kills.Add(1)
	if p.killError == nil {
		close(p.exited)
	}
	return p.killError
}

func TestOwnedBackendStopAndWait(t *testing.T) {
	for _, graceful := range []bool{true, false} {
		backend := &testProcessBackend{exited: make(chan struct{}), graceful: graceful, code: 7}
		buffer := NewRingBuffer(10)
		output := &lineLogWriter{buffer: buffer}
		_, _ = output.Write([]byte("final partial line"))
		process := &ManagedProcess{backend: backend, Done: make(chan struct{}), outputs: []*lineLogWriter{output}}
		go process.RunWait()
		timeout := 0
		if graceful {
			timeout = 1
		}
		if err := stopProcess(process, timeout); err != nil {
			t.Fatal(err)
		}
		if process.WaitDone() != 7 {
			t.Fatal("exit status lost")
		}
		if got := buffer.GetLast(1); len(got) != 1 || got[0] != "final partial line" {
			t.Fatalf("output not joined: %v", got)
		}
		wantKills := int32(1)
		if graceful {
			wantKills = 0
		}
		if backend.interrupts.Load() != 1 || backend.kills.Load() != wantKills {
			t.Fatal("incorrect escalation")
		}
		if err := process.Kill(); err != nil {
			t.Fatal(err)
		}
		if err := stopProcess(process, 0); err != nil {
			t.Fatal(err)
		}
		if backend.interrupts.Load() != 1 || backend.kills.Load() != wantKills {
			t.Fatal("completed execution was signalled again")
		}
	}
}

func TestFailedBackendTerminationDoesNotPublishCompletion(t *testing.T) {
	failure := errors.New("owned handle could not terminate")
	backend := &testProcessBackend{exited: make(chan struct{}), killError: failure}
	process := &ManagedProcess{backend: backend, Done: make(chan struct{})}
	go process.RunWait()
	if err := stopProcess(process, 0); !errors.Is(err, failure) {
		t.Fatalf("got %v", err)
	}
	select {
	case <-process.Done:
		t.Fatal("failed termination discarded live ownership")
	default:
	}
	close(backend.exited)
	process.WaitDone()
}

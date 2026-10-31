package workeripc

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

const testInstance = "0123456789abcdef0123456789abcdef"

func TestChildIdentityRequiredOnlyOnStarted(t *testing.T) {
	child := strings.Repeat("a", 32)
	for _, tc := range []struct {
		frame     Frame
		direction Direction
		valid     bool
	}{
		{Frame{Kind: "started", PID: 123, ProcessInstance: child}, Events, true},
		{Frame{Kind: "started", PID: 123}, Events, false},
		{Frame{Kind: "started", PID: 123, ProcessInstance: strings.ToUpper(child)}, Events, false},
		{Frame{Kind: "started", PID: 123, ProcessInstance: "abc"}, Events, false},
		{Frame{Kind: "started", PID: 0, ProcessInstance: child}, Events, false},
		{Frame{Kind: "log", Line: "line", ProcessInstance: child}, Events, false},
		{Frame{Kind: "exited", ExitCode: new(int), ProcessInstance: child}, Events, false},
		{Frame{Kind: "pong", ProcessInstance: child}, Events, false},
		{Frame{Kind: "start", ProcessInstance: child}, Commands, false},
	} {
		writer, _ := New(testInstance, tc.direction)
		var encoded bytes.Buffer
		err := writer.Write(&encoded, tc.frame)
		if (err == nil) != tc.valid {
			t.Fatalf("write %+v: %v", tc.frame, err)
		}
		// Construct the wire independently so the read-side validation is tested.
		tc.frame.Version, tc.frame.Instance, tc.frame.Sequence = 1, testInstance, 1
		data, err := json.Marshal(tc.frame)
		if err != nil {
			t.Fatal(err)
		}
		var wire bytes.Buffer
		_ = binary.Write(&wire, binary.BigEndian, uint32(len(data)))
		wire.Write(data)
		reader, _ := New(testInstance, tc.direction)
		got, err := reader.Read(&wire)
		if (err == nil) != tc.valid {
			t.Fatalf("read %+v: %v", tc.frame, err)
		}
		if tc.valid && got.ProcessInstance != child {
			t.Fatal("child identity lost")
		}
	}
}

func TestLifecycleFramesOverDuplexConnection(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	_ = left.SetDeadline(time.Now().Add(3 * time.Second))
	_ = right.SetDeadline(time.Now().Add(3 * time.Second))
	commandsOut, _ := New(testInstance, Commands)
	commandsIn, _ := New(testInstance, Commands)
	eventsOut, _ := New(testInstance, Events)
	eventsIn, _ := New(testInstance, Events)
	done := make(chan error, 1)
	go func() {
		for _, kind := range []string{"start", "ping", "stop"} {
			frame, err := commandsIn.Read(right)
			if err != nil {
				done <- err
				return
			}
			if frame.Kind != kind {
				done <- ErrProtocol
				return
			}
			if err := eventsOut.Write(right, Frame{Kind: "pong"}); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for _, kind := range []string{"start", "ping", "stop"} {
		if err := commandsOut.Write(left, Frame{Kind: kind}); err != nil {
			t.Fatal(err)
		}
		if frame, err := eventsIn.Read(left); err != nil || frame.Kind != "pong" {
			t.Fatalf("frame=%+v error=%v", frame, err)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRejectReplayWrongInstanceAndDirection(t *testing.T) {
	writer, _ := New(testInstance, Commands)
	var wire bytes.Buffer
	if err := writer.Write(&wire, Frame{Kind: "start"}); err != nil {
		t.Fatal(err)
	}
	frame := append([]byte(nil), wire.Bytes()...)
	reader, _ := New(testInstance, Commands)
	if _, err := reader.Read(bytes.NewReader(frame)); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Read(bytes.NewReader(frame)); !errors.Is(err, ErrProtocol) {
		t.Fatal("replay accepted")
	}
	wire.Reset()
	_ = writer.Write(&wire, Frame{Kind: "stop"})
	if _, err := reader.Read(&wire); !errors.Is(err, ErrProtocol) {
		t.Fatal("failed stream reused")
	}
	for _, setup := range []struct {
		instance  string
		direction Direction
	}{{strings.Repeat("f", 32), Commands}, {testInstance, Events}} {
		r, _ := New(setup.instance, setup.direction)
		if _, err := r.Read(bytes.NewReader(frame)); !errors.Is(err, ErrProtocol) {
			t.Fatal("foreign frame accepted")
		}
	}
}

func TestReadRejectsInvalidAndOversizedFrames(t *testing.T) {
	for _, payload := range []string{
		`{"version":1,"instance":"` + testInstance + `","sequence":1,"kind":"start","exe":"anything"}`,
		`{"version":2,"instance":"` + testInstance + `","sequence":1,"kind":"start"}`,
		`{"version":1,"instance":"` + testInstance + `","sequence":2,"kind":"start"}`,
		`{"version":1,"instance":"` + testInstance + `","sequence":1,"kind":"log"}`,
		`null`, `{}`, `{} {}`, `{"version":`,
	} {
		var wire bytes.Buffer
		_ = binary.Write(&wire, binary.BigEndian, uint32(len(payload)))
		wire.WriteString(payload)
		r, _ := New(testInstance, Commands)
		if _, err := r.Read(&wire); !errors.Is(err, ErrProtocol) {
			t.Fatalf("payload=%s error=%v", payload, err)
		}
	}
	for _, size := range []uint32{0, MaxFrameBytes + 1, ^uint32(0)} {
		var header bytes.Buffer
		_ = binary.Write(&header, binary.BigEndian, size)
		r, _ := New(testInstance, Commands)
		if _, err := r.Read(&header); !errors.Is(err, ErrProtocol) {
			t.Fatalf("size=%d error=%v", size, err)
		}
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return w.Buffer.Write(p)
}

type stalledWriter struct{}

func (stalledWriter) Write([]byte) (int, error) { return 0, nil }

func TestBoundedEventWritesAndPartialIO(t *testing.T) {
	writer, _ := New(testInstance, Events)
	reader, _ := New(testInstance, Events)
	wire := &shortWriter{}
	for _, frame := range []Frame{{Kind: "started", PID: 123, ProcessInstance: strings.Repeat("a", 32)}, {Kind: "log", Line: strings.Repeat("x", MaxLogBytes)}, {Kind: "exited", ExitCode: new(int)}} {
		if err := writer.Write(wire, frame); err != nil {
			t.Fatal(err)
		}
		if _, err := reader.Read(wire); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Write(io.Discard, Frame{Kind: "log", Line: strings.Repeat("x", MaxLogBytes+1)}); !errors.Is(err, ErrProtocol) {
		t.Fatal("oversized log accepted")
	}
	writer, _ = New(testInstance, Commands)
	if err := writer.Write(stalledWriter{}, Frame{Kind: "ping"}); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
	if err := writer.Write(io.Discard, Frame{Kind: "ping"}); !errors.Is(err, ErrProtocol) {
		t.Fatal("partial write reused")
	}
}

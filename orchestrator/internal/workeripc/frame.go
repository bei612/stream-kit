// Package workeripc defines the private rendering-worker wire protocol.
// Framing is not authentication: callers must validate the OS pipe peer before
// passing a connection here. No listener or arbitrary execution API is exposed.
package workeripc

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
)

const MaxFrameBytes = 128 << 10
const MaxLogBytes = 64 << 10

var ErrProtocol = errors.New("render worker protocol violation")

// Frame carries only lifecycle commands and observations. Executable paths,
// arguments and credentials belong to trusted launch configuration, not to a
// generic command-execution request on this channel.
type Frame struct {
	Version  int    `json:"version"`
	Instance string `json:"instance"`
	Sequence uint64 `json:"sequence"`
	Kind     string `json:"kind"`
	PID      int    `json:"pid,omitempty"`
	// ProcessInstance is the child's launch identity, distinct from the worker
	// channel Instance. It must match the identity injected into the child.
	ProcessInstance string `json:"process_instance,omitempty"`
	ExitCode        *int   `json:"exit_code,omitempty"`
	Line            string `json:"line,omitempty"`
}

type Direction uint8

const (
	Commands Direction = iota
	Events
)

// Stream is unidirectional and single-owner. Use one for commands and one for
// events. Any failed frame permanently invalidates this stream; reconnecting
// requires a new, OS-authenticated worker instance, never a sequence reset.
type Stream struct {
	instance  string
	direction Direction
	sequence  uint64
	failed    bool
}

func New(instance string, direction Direction) (*Stream, error) {
	if !validInstance(instance) || direction > Events {
		return nil, ErrProtocol
	}
	return &Stream{instance: instance, direction: direction}, nil
}

func validInstance(instance string) bool {
	decoded, err := hex.DecodeString(instance)
	return err == nil && len(decoded) == 16 && instance == strings.ToLower(instance)
}

func (s *Stream) valid(f Frame) bool {
	if s.failed || s.sequence == math.MaxUint64 || f.Version != 1 || f.Instance != s.instance || f.Sequence != s.sequence+1 {
		return false
	}
	if f.Kind != "started" && f.ProcessInstance != "" {
		return false
	}
	if s.direction == Commands {
		return (f.Kind == "start" || f.Kind == "stop" || f.Kind == "kill" || f.Kind == "ping") && f.PID == 0 && f.ExitCode == nil && f.Line == ""
	}
	switch f.Kind {
	case "started":
		return f.PID > 0 && uint64(f.PID) <= math.MaxUint32 && validInstance(f.ProcessInstance) && f.ExitCode == nil && f.Line == ""
	case "log":
		return f.PID == 0 && f.ExitCode == nil && len(f.Line) <= MaxLogBytes
	case "exited":
		return f.PID == 0 && f.ExitCode != nil && f.Line == ""
	case "pong":
		return f.PID == 0 && f.ExitCode == nil && f.Line == ""
	default:
		return false
	}
}

func (s *Stream) Read(r io.Reader) (frame Frame, err error) {
	defer func() {
		if err != nil {
			s.failed = true
		}
	}()
	if s.failed {
		return frame, ErrProtocol
	}
	var header [4]byte
	if _, err = io.ReadFull(r, header[:]); err != nil {
		return frame, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > MaxFrameBytes {
		return frame, ErrProtocol
	}
	data := make([]byte, size)
	if _, err = io.ReadFull(r, data); err != nil {
		return frame, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&frame); err != nil {
		return Frame{}, ErrProtocol
	}
	if decoder.Decode(new(any)) != io.EOF || !s.valid(frame) {
		return Frame{}, ErrProtocol
	}
	s.sequence = frame.Sequence
	return frame, nil
}

func (s *Stream) Write(w io.Writer, frame Frame) (err error) {
	defer func() {
		if err != nil {
			s.failed = true
		}
	}()
	frame.Version, frame.Instance, frame.Sequence = 1, s.instance, s.sequence+1
	if !s.valid(frame) {
		return ErrProtocol
	}
	data, err := json.Marshal(frame)
	if err != nil || len(data) > MaxFrameBytes {
		return ErrProtocol
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	if err = writeAll(w, header[:]); err != nil {
		return err
	}
	if err = writeAll(w, data); err != nil {
		return err
	}
	s.sequence = frame.Sequence
	return nil
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if n < 0 || n > len(data) {
			return io.ErrShortWrite
		}
		data = data[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

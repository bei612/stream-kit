//go:build windows

package workeripc

import (
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

type deadlineFile interface {
	io.ReadWriteCloser
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

// Conn uses Microsoft's overlapped-I/O implementation for independent pipe
// reads and writes. Handle inspection is serialized only with Close, never with
// I/O: bidirectional heartbeat/control traffic must not block behind a read.
// os.File pipe offsets race in the released Go versions we verified; upstream
// fix: https://go-review.googlesource.com/c/go/+/829144 (not a local runtime patch).
type Conn struct {
	file   deadlineFile
	mu     sync.Mutex
	handle windows.Handle
	closed bool
}

// newConnection transfers handle ownership only on success.
func newConnection(handle windows.Handle) (*Conn, error) {
	file, err := winio.NewOpenFile(handle)
	if err != nil {
		return nil, err
	}
	return &Conn{file: file.(deadlineFile), handle: handle}, nil
}

func (c *Conn) Read(data []byte) (int, error)             { return c.file.Read(data) }
func (c *Conn) Write(data []byte) (int, error)            { return c.file.Write(data) }
func (c *Conn) SetReadDeadline(deadline time.Time) error  { return c.file.SetReadDeadline(deadline) }
func (c *Conn) SetWriteDeadline(deadline time.Time) error { return c.file.SetWriteDeadline(deadline) }
func (c *Conn) SetDeadline(deadline time.Time) error {
	return errors.Join(c.SetReadDeadline(deadline), c.SetWriteDeadline(deadline))
}
func (c *Conn) WithHandle(fn func(windows.Handle) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return os.ErrClosed
	}
	return fn(c.handle)
}
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return c.file.Close()
}

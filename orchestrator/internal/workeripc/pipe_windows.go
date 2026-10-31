//go:build windows

package workeripc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const pipePrefix = `\\.\pipe\stream-kit-worker-`

// Exclude FILE_CREATE_PIPE_INSTANCE (the same bit as FILE_APPEND_DATA).
const pipeClientAccess = (windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE) &^ windows.FILE_APPEND_DATA

// Listener owns exactly one local connection for one launched worker instance.
// Accepted connections still require VerifyPeer before any protocol exchange.
type Listener struct {
	mu        sync.Mutex
	handle    windows.Handle
	name      string
	closed    bool
	accepting bool
	done      chan struct{}
}

func Listen(instance, userSID string) (*Listener, error) {
	if _, err := New(instance, Commands); err != nil {
		return nil, err
	}
	sid, err := windows.StringToSid(userSID)
	if err != nil {
		return nil, ErrPeerIdentity
	}
	// No Everyone, Authenticated Users, or inherited ACE. The worker account
	// gets byte I/O rights, not permission to create another server instance.
	sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("D:P(A;;GA;;;SY)(A;;0x%x;;;%s)", pipeClientAccess, sid.String()))
	if err != nil {
		return nil, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	name := pipePrefix + instance
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateNamedPipe(path, windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, &sa)
	if err != nil {
		return nil, err
	}
	return &Listener{handle: h, name: name}, nil
}

func (l *Listener) Name() string { return l.name }

func (l *Listener) Accept(ctx context.Context) (*Conn, error) {
	l.mu.Lock()
	if l.closed || l.accepting {
		l.mu.Unlock()
		return nil, os.ErrClosed
	}
	if err := ctx.Err(); err != nil {
		l.mu.Unlock()
		return nil, err
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		l.mu.Unlock()
		return nil, err
	}
	defer windows.CloseHandle(event)
	l.accepting = true
	l.done = make(chan struct{})
	h := l.handle
	operation := windows.Overlapped{HEvent: event}
	// Register pending I/O before Close is allowed to cancel it.
	err = windows.ConnectNamedPipe(h, &operation)
	l.mu.Unlock()
	if errors.Is(err, windows.ERROR_IO_PENDING) {
		cancelled := make(chan struct{})
		stop := context.AfterFunc(ctx, func() { _ = windows.CancelIoEx(h, &operation); close(cancelled) })
		var transferred uint32
		err = windows.GetOverlappedResult(h, &operation, &transferred, true)
		if !stop() {
			<-cancelled
		}
	} else if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		err = nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	defer close(l.done)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if l.closed {
		return nil, os.ErrClosed
	}
	if err != nil {
		return nil, err
	}
	file, err := newConnection(h)
	if err != nil {
		return nil, err
	}
	l.handle = windows.InvalidHandle // ownership moves to the IOCP connection
	return file, nil
}

func (l *Listener) Close() error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	h, done := l.handle, l.done
	if h != windows.InvalidHandle {
		_ = windows.CancelIoEx(h, nil)
	}
	l.mu.Unlock()
	if done != nil {
		<-done
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.handle == windows.InvalidHandle {
		return nil
	}
	err := windows.CloseHandle(l.handle)
	l.handle = windows.InvalidHandle
	return err
}

// Dial permits only repository-owned local pipe names and anonymous SQOS: a
// pipe server cannot impersonate the connecting user's token. Peer identity
// must still be verified against the retained service process handle.
func Dial(ctx context.Context, name string) (*Conn, error) {
	if !strings.HasPrefix(name, pipePrefix) {
		return nil, ErrProtocol
	}
	if _, err := New(strings.TrimPrefix(name, pipePrefix), Commands); err != nil {
		return nil, err
	}
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h, err := windows.CreateFile(path, pipeClientAccess, 0, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_ANONYMOUS, 0)
		if err == nil {
			file, err := newConnection(h)
			if err != nil {
				_ = windows.CloseHandle(h)
				return nil, err
			}
			return file, nil
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return nil, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

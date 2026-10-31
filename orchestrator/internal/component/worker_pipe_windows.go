//go:build windows

package component

import (
	"context"
	"errors"
	"time"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"golang.org/x/sys/windows"
)

// dialNativeController authenticates the server before any lifecycle frame is
// consumed. controller must be retained using trusted launch identity and kept
// open until this connection is closed; no PID from the pipe may authorize it.
func dialNativeController(parent context.Context, name string, controller windows.Handle, sid string, session uint32) (_ *workeripc.Conn, result error) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	connection, err := workeripc.Dial(ctx, name)
	if err != nil {
		return nil, err
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, connection.Close())
		}
	}()
	if err = verifyNativeConnection(connection, workeripc.ServerPeer, controller, sid, session); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return connection, nil
}

func verifyNativeConnection(connection *workeripc.Conn, side workeripc.PeerSide, process windows.Handle, sid string, session uint32) error {
	return connection.WithHandle(func(handle windows.Handle) error { return workeripc.VerifyPeer(handle, side, process, sid, session) })
}

// acceptNativeWorker consumes the one-shot listener and resumes the contained
// process. Failure closes its job; success transfers the authenticated connection
// to the caller, which must retain worker ownership for its entire lifetime.
func acceptNativeWorker(parent context.Context, listener *workeripc.Listener, worker *nativeWorker, sid string, session uint32) (_ *workeripc.Conn, result error) {
	defer listener.Close()
	defer func() {
		if result != nil {
			result = errors.Join(result, worker.Close())
		}
	}()
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := worker.Resume(); err != nil {
		return nil, err
	}
	connection, err := listener.Accept(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, connection.Close())
		}
	}()
	if err = verifyNativeConnection(connection, workeripc.ClientPeer, worker.process, sid, session); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return connection, nil
}

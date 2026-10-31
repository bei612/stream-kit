//go:build windows

package component

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"golang.org/x/sys/windows"
)

// acceptNativeWorker consumes the one-shot listener and resumes the contained
// process. Failure closes its job; success transfers the authenticated connection
// to the caller, which must retain worker ownership for its entire lifetime.
func acceptNativeWorker(parent context.Context, listener *workeripc.Listener, worker *nativeWorker, sid string, session uint32) (_ *os.File, result error) {
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
	raw, err := connection.SyscallConn()
	if err != nil {
		return nil, err
	}
	var identityError error
	if err = raw.Control(func(handle uintptr) {
		identityError = workeripc.VerifyPeer(windows.Handle(handle), workeripc.ClientPeer, worker.process, sid, session)
	}); err != nil {
		return nil, err
	}
	if identityError != nil {
		return nil, identityError
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return connection, nil
}

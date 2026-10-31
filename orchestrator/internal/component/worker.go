package component

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/stream-kit/orchestrator/internal/workeripc"
)

type workerConnection interface {
	io.ReadWriteCloser
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

// serveWorker is the single-execution lifecycle core. The launch callback is
// trusted local configuration, not wire input. Callers must authenticate the
// OS connection before entering this function. No public command endpoint uses
// this function until the platform launcher and peer validation are integrated.
func serveWorker(parent context.Context, connection workerConnection, instance string,
	launch func(*RingBuffer) (*ManagedProcess, error),
) (result error) {
	commands, err := workeripc.New(instance, workeripc.Commands)
	if err != nil {
		return err
	}
	events, err := workeripc.New(instance, workeripc.Events)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stopClose := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopClose()
	defer connection.Close()
	type incoming struct {
		frame workeripc.Frame
		err   error
	}
	input := make(chan incoming)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			err := connection.SetReadDeadline(time.Now().Add(30 * time.Second))
			var frame workeripc.Frame
			if err == nil {
				frame, err = commands.Read(connection)
			}
			select {
			case input <- incoming{frame, err}:
			case <-ctx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); _ = connection.Close(); <-readerDone }()
	write := func(frame workeripc.Frame) error {
		if err := connection.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return err
		}
		return events.Write(connection, frame)
	}
	logs := NewRingBuffer(2000)
	logStream := logs.Subscribe()
	defer logs.Unsubscribe(logStream)
	var process *ManagedProcess
	var exited <-chan struct{}
	defer func() {
		if process != nil {
			result = errors.Join(result, stopProcess(process, 1))
		}
	}()
	forwardLog := func(line string, open bool) error {
		if !open {
			logStream = nil
			line = "[worker log forwarding stopped: receiver too slow]"
		}
		return write(workeripc.Frame{Kind: "log", Line: line})
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case request := <-input:
			if request.err != nil {
				return request.err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if process == nil && request.frame.Kind != "start" {
				return workeripc.ErrProtocol
			}
			switch request.frame.Kind {
			case "start":
				if process != nil {
					return workeripc.ErrProtocol
				}
				process, err = launch(logs)
				// Ownership transfers even if launch reports a post-start failure.
				if process != nil {
					go process.RunWait()
					exited = process.Done
				}
				if err != nil {
					return err
				}
				if process == nil {
					return workeripc.ErrProtocol
				}
				if err := write(workeripc.Frame{Kind: "started", PID: process.PID}); err != nil {
					return err
				}
			case "ping":
				if err := write(workeripc.Frame{Kind: "pong"}); err != nil {
					return err
				}
			case "stop":
				if err := stopProcess(process, 1); err != nil {
					return err
				}
			case "kill":
				if err := forceStop(process); err != nil {
					return err
				}
			}
		case line, open := <-logStream:
			if err := forwardLog(line, open); err != nil {
				return err
			}
		case <-exited:
			// RunWait publishes Done only after final partial output is flushed.
			for logStream != nil {
				select {
				case line, open := <-logStream:
					if err := forwardLog(line, open); err != nil {
						return err
					}
				default:
					logStream = nil
				}
			}
			return write(workeripc.Frame{Kind: "exited", ExitCode: &process.ExitCode})
		}
	}
}

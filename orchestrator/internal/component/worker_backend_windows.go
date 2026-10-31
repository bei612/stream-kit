//go:build windows

package component

import (
	"context"
	"errors"
	"sync"
	"time"
	"unsafe"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"golang.org/x/sys/windows"
)

type workerProcess struct {
	ctx        context.Context
	connection *workeripc.Conn
	commands   *workeripc.Stream
	events     *workeripc.Stream
	worker     *nativeWorker
	snapshot   *workerSnapshot
	logs       *RingBuffer
	writeMu    sync.Mutex
	ownerMu    sync.Mutex
	closed     bool
}

// attachWorkerProcess transfers ownership only on success. On failure the
// launcher still owns the connection, native job and snapshot and must clean up.
// The caller runs ManagedProcess.RunWait exactly once, like a direct process.
func attachWorkerProcess(ctx context.Context, connection *workeripc.Conn, instance string, worker *nativeWorker, snapshot *workerSnapshot, logs *RingBuffer) (*ManagedProcess, error) {
	commands, err := workeripc.New(instance, workeripc.Commands)
	if err != nil {
		return nil, err
	}
	events, err := workeripc.New(instance, workeripc.Events)
	if err != nil {
		return nil, err
	}
	process := &workerProcess{ctx: ctx, connection: connection, commands: commands, events: events, worker: worker, snapshot: snapshot, logs: logs}
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stop()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = process.send("start"); err != nil {
		return nil, err
	}
	if err = connection.SetReadDeadline(time.Now().Add(20 * time.Second)); err != nil {
		return nil, err
	}
	started, err := events.Read(connection)
	if err != nil {
		return nil, err
	}
	if started.Kind != "started" || started.PID == int(worker.pid) {
		return nil, workeripc.ErrProtocol
	}
	return &ManagedProcess{backend: process, PID: started.PID, InstanceID: started.ProcessInstance, LogBuf: logs, Done: make(chan struct{})}, nil
}

func (p *workerProcess) send(kind string) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.connection.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return p.commands.Write(p.connection, workeripc.Frame{Kind: kind})
}

func (p *workerProcess) interrupt() error { return p.send("stop") }

func (p *workerProcess) kill() error {
	p.ownerMu.Lock()
	defer p.ownerMu.Unlock()
	if p.closed {
		return nil
	}
	return windows.TerminateJobObject(p.worker.job, 1)
}

func (p *workerProcess) wait() (code int, result error) {
	code = -1
	ctx, cancel := context.WithCancel(p.ctx)
	stop := context.AfterFunc(ctx, func() { _ = p.connection.Close() })
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if p.send("ping") != nil {
					_ = p.connection.Close()
					return
				}
			}
		}
	}()
	for {
		if err := p.connection.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
			result = err
			break
		}
		frame, err := p.events.Read(p.connection)
		if err != nil {
			result = err
			break
		}
		switch frame.Kind {
		case "log":
			p.logs.Write(frame.Line)
		case "pong":
		case "exited":
			code = *frame.ExitCode
		default:
			result = workeripc.ErrProtocol
		}
		if frame.Kind == "exited" || result != nil {
			break
		}
	}
	cancel()
	_ = p.connection.Close()
	stop()
	<-heartbeatDone
	if result == nil {
		// Allow the worker to return after publishing the child's exit event.
		status, err := windows.WaitForSingleObject(p.worker.process, 5000)
		if err != nil || status != windows.WAIT_OBJECT_0 {
			result = errors.New("render worker failed to exit after child completion")
		}
	}
	// Never publish Done while the job still contains processes. If a native
	// termination/query fails, retain ownership; a subsequent Kill can retry.
	waitWorkerTree(p.worker, p.kill, p.logs)
	p.ownerMu.Lock()
	result = errors.Join(result, p.worker.Close())
	p.closed = true
	p.ownerMu.Unlock()
	result = errors.Join(result, p.snapshot.Close())
	return code, result
}

func waitWorkerTree(worker *nativeWorker, terminate func() error, logs *RingBuffer) {
	warned := false
	for {
		err := terminate()
		var accounting struct {
			TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
			TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
		}
		queryErr := windows.QueryInformationJobObject(worker.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
		if queryErr == nil && accounting.ActiveProcesses == 0 {
			break
		}
		if (err != nil || queryErr != nil) && !warned {
			if logs != nil {
				logs.Write("[worker cleanup pending: native process ownership retained]")
			}
			warned = true
		}
		time.Sleep(50 * time.Millisecond)
	}
}

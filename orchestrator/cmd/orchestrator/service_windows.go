//go:build windows

package main

import (
	"context"
	"time"

	"golang.org/x/sys/windows/svc"
)

func runPlatform(run func(context.Context, func()) error) error {
	isService, err := svc.IsWindowsService()
	if err != nil {
		return err
	}
	if !isService {
		return runConsole(run)
	}
	h := &serviceHandler{run: run}
	if err := svc.Run("StreamKitOrchestrator", h); err != nil {
		return err
	}
	return h.err
}

type serviceHandler struct {
	run func(context.Context, func()) error
	err error
}

func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready, done := make(chan struct{}, 1), make(chan error, 1)
	status := svc.Status{State: svc.StartPending, WaitHint: 10000, CheckPoint: 1}
	changes <- status
	go func() {
		done <- h.run(ctx, func() {
			select {
			case ready <- struct{}{}:
			default:
			}
		})
	}()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			h.err = err
			if err != nil {
				return true, 1
			}
			return false, 0
		case <-ready:
			if status.State == svc.StartPending {
				status = svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
				changes <- status
			}
		case request, ok := <-requests:
			if !ok {
				requests = nil
				cancel()
				status = svc.Status{State: svc.StopPending, WaitHint: 10000, CheckPoint: 1}
				changes <- status
				continue
			}
			switch request.Cmd {
			case svc.Interrogate:
				changes <- status
			case svc.Stop, svc.Shutdown:
				if status.State != svc.StopPending {
					status = svc.Status{State: svc.StopPending, WaitHint: 10000, CheckPoint: 1}
					changes <- status
					cancel()
				}
			}
		case <-tick.C:
			if status.State == svc.StartPending || status.State == svc.StopPending {
				status.CheckPoint++
				changes <- status
			}
		}
	}
}

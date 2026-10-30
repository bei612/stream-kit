//go:build windows

package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

func TestServiceLifecycle(t *testing.T) {
	for _, command := range []svc.Cmd{svc.Stop, svc.Shutdown} {
		t.Run(string(rune(command)), func(t *testing.T) {
			cleaned := make(chan struct{})
			release := make(chan struct{})
			h := &serviceHandler{run: func(ctx context.Context, ready func()) error {
				ready()
				<-ctx.Done()
				<-release
				close(cleaned)
				return nil
			}}
			requests := make(chan svc.ChangeRequest, 4)
			statuses := make(chan svc.Status, 8)
			done := make(chan uint32, 1)
			go func() { _, code := h.Execute(nil, requests, statuses); done <- code }()
			expectStatus(t, statuses, svc.StartPending)
			expectStatus(t, statuses, svc.Running)
			requests <- svc.ChangeRequest{Cmd: svc.Interrogate}
			expectStatus(t, statuses, svc.Running)
			requests <- svc.ChangeRequest{Cmd: command}
			expectStatus(t, statuses, svc.StopPending)
			select {
			case <-done:
				t.Fatal("service exited before runtime cleanup")
			default:
			}
			close(release)
			select {
			case code := <-done:
				if code != 0 {
					t.Fatalf("exit code %d", code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("stop did not complete")
			}
			select {
			case <-cleaned:
			default:
				t.Fatal("cleanup missing")
			}
		})
	}
}

func TestServiceStartupFailureAndEarlyStop(t *testing.T) {
	for _, fail := range []bool{true, false} {
		requests := make(chan svc.ChangeRequest, 1)
		statuses := make(chan svc.Status, 8)
		done := make(chan uint32, 1)
		h := &serviceHandler{run: func(ctx context.Context, ready func()) error {
			if fail {
				return errors.New("startup failed")
			}
			<-ctx.Done()
			ready()
			return nil
		}}
		go func() {
			specific, code := h.Execute(nil, requests, statuses)
			if fail && !specific {
				done <- 99
			} else {
				done <- code
			}
		}()
		expectStatus(t, statuses, svc.StartPending)
		if !fail {
			requests <- svc.ChangeRequest{Cmd: svc.Stop}
			expectStatus(t, statuses, svc.StopPending)
		}
		select {
		case code := <-done:
			if (code != 0) != fail {
				t.Fatalf("failure=%v code=%d", fail, code)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("service did not finish")
		}
		select {
		case s := <-statuses:
			if s.State == svc.Running {
				t.Fatal("reported running after failed/cancelled startup")
			}
		default:
		}
	}
}

func expectStatus(t *testing.T, statuses <-chan svc.Status, want svc.State) {
	t.Helper()
	select {
	case s := <-statuses:
		if s.State != want {
			t.Fatalf("state=%v want=%v", s.State, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("missing state %v", want)
	}
}

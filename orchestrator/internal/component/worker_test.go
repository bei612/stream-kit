package component

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"go.uber.org/zap"
)

func TestWorkerChild(t *testing.T) {
	mode := os.Getenv("STREAM_KIT_WORKER_TEST")
	if mode == "" {
		return
	}
	fmt.Print("worker-ready\n")
	fmt.Println("instance=" + os.Getenv("STREAM_KIT_PROCESS_INSTANCE"))
	if mode == "exit" {
		fmt.Print("final-partial")
		os.Exit(7)
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestWorkerLifecycle(t *testing.T) {
	for _, mode := range []string{"exit", "stop", "kill", "disconnect", "cancel", "duplicate", "launch-error"} {
		t.Run(mode, func(t *testing.T) {
			server, client := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(15 * time.Second))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			const instance = "0123456789abcdef0123456789abcdef"
			commands, _ := workeripc.New(instance, workeripc.Commands)
			events, _ := workeripc.New(instance, workeripc.Events)
			launched := make(chan *ManagedProcess, 2)
			finished := make(chan error, 1)
			go func() {
				finished <- serveWorker(ctx, server, instance, func(logs *RingBuffer) (*ManagedProcess, error) {
					p, err := StartProcess(os.Args[0], "-test.run=^TestWorkerChild$", "", map[string]string{"STREAM_KIT_WORKER_TEST": mode}, logs, zap.NewNop())
					if p != nil {
						launched <- p
					}
					if mode == "launch-error" && err == nil {
						err = errors.New("post-start failure")
					}
					return p, err
				})
			}()
			if err := commands.Write(client, workeripc.Frame{Kind: "start"}); err != nil {
				t.Fatal(err)
			}
			var process *ManagedProcess
			select {
			case process = <-launched:
			case <-time.After(10 * time.Second):
				t.Fatal("launch timeout")
			}
			t.Cleanup(func() { _ = process.Kill() })
			if mode != "launch-error" {
				frame, err := events.Read(client)
				if err != nil || frame.Kind != "started" || frame.PID != process.PID || frame.ProcessInstance != process.InstanceID || frame.ProcessInstance == instance {
					t.Fatalf("started: %+v %v", frame, err)
				}
			}
			switch mode {
			case "disconnect":
				_ = client.Close()
			case "cancel":
				cancel()
			case "duplicate":
				if err := commands.Write(client, workeripc.Frame{Kind: "start"}); err != nil {
					t.Fatal(err)
				}
				for {
					if _, err := events.Read(client); err != nil {
						break
					}
				}
			case "stop", "kill":
				// Drain output while sending commands: both directions may be active.
				go func() { _ = commands.Write(client, workeripc.Frame{Kind: mode}) }()
			}
			if mode == "exit" || mode == "stop" || mode == "kill" {
				var output []string
				for {
					frame, err := events.Read(client)
					if err != nil {
						t.Fatal(err)
					}
					if frame.Kind == "log" {
						output = append(output, frame.Line)
					}
					if frame.Kind == "exited" {
						if mode == "exit" && !strings.Contains(strings.Join(output, "\n"), "instance="+process.InstanceID) {
							t.Fatal("started identity does not match child environment")
						}
						if mode == "exit" && (*frame.ExitCode != 7 || !strings.Contains(strings.Join(output, "\n"), "final-partial")) {
							t.Fatalf("exit/logs: %+v %v", frame, output)
						}
						break
					}
				}
			}
			select {
			case err := <-finished:
				if (mode == "exit" || mode == "stop" || mode == "kill") && err != nil {
					t.Fatal(err)
				}
				if mode == "duplicate" && !errors.Is(err, workeripc.ErrProtocol) {
					t.Fatalf("duplicate: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("worker teardown timeout")
			}
			select {
			case <-process.Done:
			default:
				t.Fatal("child not reaped")
			}
			select {
			case <-launched:
				t.Fatal("launched more than once")
			default:
			}
		})
	}
}

func TestWorkerRejectsBeforeLaunch(t *testing.T) {
	for _, kind := range []string{"ping", "stop", "kill"} {
		t.Run(kind, func(t *testing.T) {
			server, client := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(5 * time.Second))
			const instance = "0123456789abcdef0123456789abcdef"
			finished := make(chan error, 1)
			go func() {
				finished <- serveWorker(context.Background(), server, instance, func(*RingBuffer) (*ManagedProcess, error) { return nil, errors.New("unexpected launch") })
			}()
			commands, _ := workeripc.New(instance, workeripc.Commands)
			if err := commands.Write(client, workeripc.Frame{Kind: kind}); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-finished:
				if !errors.Is(err, workeripc.ErrProtocol) {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("timeout")
			}
		})
	}
}

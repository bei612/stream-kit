//go:build windows

package component

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"golang.org/x/sys/windows"
)

func TestSessionWorkerLaunchTransaction(t *testing.T) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	var session uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &session); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"exit", "hold-stop", "session-lost", "spawn-error", "cancelled", "preflight-failure", "foreign-session"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			cfg := config.ComponentConfig{ExePath: os.Args[0], Args: "-test.run=^TestWorkerChild$", Env: map[string]string{"STREAM_KIT_WORKER_TEST": "exit"}}
			if mode == "hold-stop" || mode == "session-lost" {
				cfg.Env["STREAM_KIT_WORKER_TEST"] = "hold"
			}
			if mode == "preflight-failure" {
				cfg.PreflightArgs = cfg.Args
			}
			expectedSession := session
			if mode == "foreign-session" {
				expectedSession++
			}
			spawned := 0
			var guardCalls atomic.Int32
			var guard func() error
			if mode == "session-lost" {
				guard = func() error {
					if guardCalls.Add(1) == 1 {
						return nil
					}
					return errors.New("test session no longer matches")
				}
			}
			logs := NewRingBuffer(2000)
			var retained windows.Handle
			process, err := launchSessionWorker(ctx, cfg, root, expectedSession, user.User.Sid.String(), logs, func(args []string) (*nativeWorker, error) {
				spawned++
				if mode == "spawn-error" {
					return nil, errors.New("test native launch failure")
				}
				exe := os.Args[0]
				if binary := os.Getenv("STREAM_KIT_TEST_WORKER_BINARY"); binary != "" {
					exe = binary
				} else {
					args = append([]string{"-test.run=^TestNativePipeWorkerHelper$", "--"}, args[1:]...)
				}
				worker, err := createSuspendedWorker(exe, args, filepath.Dir(exe), func(app, command, directory *uint16, startup *windows.StartupInfo, process *windows.ProcessInformation) error {
					return windows.CreateProcess(app, command, nil, nil, false, windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW, nil, directory, startup, process)
				})
				if err == nil {
					retained = retainNativeProcess(t, worker.pid)
				}
				return worker, err
			}, guard)
			if mode == "exit" || mode == "hold-stop" || mode == "session-lost" {
				if err != nil {
					t.Fatal(err)
				}
				var child windows.Handle
				if mode == "session-lost" {
					child = retainNativeProcess(t, uint32(process.PID))
				}
				go process.RunWait()
				if mode == "hold-stop" {
					if err := stopProcess(process, 3); err != nil {
						t.Fatal(err)
					}
				}
				select {
				case <-process.Done:
				case <-ctx.Done():
					t.Fatal("launch transaction did not finish")
				}
				if mode == "exit" && process.ExitCode != 7 {
					t.Fatalf("exit: %d", process.ExitCode)
				}
				if mode == "session-lost" && (guardCalls.Load() != 2 || process.ExitCode == 0 || !strings.Contains(strings.Join(logs.GetLast(2000), "\n"), "session unavailable")) {
					t.Fatal("session loss did not stop the owned renderer")
				}
				if child != 0 {
					assertNativeExited(t, child)
				}
			} else if err == nil || process != nil {
				t.Fatal("failed launch returned ownership as successful")
			}
			if mode == "cancelled" && spawned != 0 {
				t.Fatal("cancelled launch spawned a process")
			}
			if retained != 0 {
				assertNativeExited(t, retained)
			}
			entries, readErr := os.ReadDir(root)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("launch resources remain: %v %v; launch error: %v", entries, readErr, err)
			}
		})
	}
}

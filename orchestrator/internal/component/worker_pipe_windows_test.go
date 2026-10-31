//go:build windows

package component

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"go.uber.org/zap"
	"golang.org/x/sys/windows"
)

func TestNativePipeWorkerHelper(t *testing.T) {
	var pipe, instance string
	for i, arg := range os.Args {
		if arg == "--" && i+2 < len(os.Args) {
			pipe, instance = os.Args[i+1], os.Args[i+2]
			break
		}
	}
	if pipe == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	connection, err := workeripc.Dial(ctx, pipe)
	if err != nil {
		os.Exit(31)
	}
	// Test-only client: production entry must also authenticate the server.
	err = serveWorker(ctx, connection, instance, func(logs *RingBuffer) (*ManagedProcess, error) {
		return StartProcess(os.Args[0], "-test.run=^TestWorkerChild$", "", map[string]string{"STREAM_KIT_WORKER_TEST": "exit"}, logs, zap.NewNop())
	})
	if err != nil {
		os.Exit(32)
	}
	os.Exit(0)
}

func TestNativeWorkerAuthenticatedLifecycle(t *testing.T) {
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
	for _, mode := range []string{"lifecycle", "wrong-session", "foreign-process", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			var nonce [16]byte
			if _, err := rand.Read(nonce[:]); err != nil {
				t.Fatal(err)
			}
			instance := hex.EncodeToString(nonce[:])
			listener, err := workeripc.Listen(instance, user.User.Sid.String())
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			worker, err := createSuspendedWorker(os.Args[0], []string{"-test.run=^TestNativePipeWorkerHelper$", "--", listener.Name(), instance}, filepath.Dir(os.Args[0]),
				func(app, command, directory *uint16, startup *windows.StartupInfo, process *windows.ProcessInformation) error {
					return windows.CreateProcess(app, command, nil, nil, false, windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW, nil, directory, startup, process)
				})
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Close()
			retained := retainNativeProcess(t, worker.pid)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			expectedSession := session
			if mode == "wrong-session" {
				expectedSession++
			}
			if mode == "cancelled" {
				cancel()
			}
			if mode == "foreign-process" {
				// Same user and session, but not the retained launched process.
				foreign, err := workeripc.Dial(ctx, listener.Name())
				if err != nil {
					t.Fatal(err)
				}
				defer foreign.Close()
			}
			connection, err := acceptNativeWorker(ctx, listener, worker, user.User.Sid.String(), expectedSession)
			if mode != "lifecycle" {
				if err == nil || connection != nil {
					t.Fatal("unauthorized connection accepted")
				}
				if (mode == "wrong-session" || mode == "foreign-process") && !errors.Is(err, workeripc.ErrPeerIdentity) {
					t.Fatal(err)
				}
				if mode == "cancelled" && !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
				assertNativeExited(t, retained)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
			commands, _ := workeripc.New(instance, workeripc.Commands)
			events, _ := workeripc.New(instance, workeripc.Events)
			if err := commands.Write(connection, workeripc.Frame{Kind: "start"}); err != nil {
				t.Fatal(err)
			}
			started, err := events.Read(connection)
			if err != nil || started.Kind != "started" || started.PID == int(worker.pid) {
				t.Fatalf("start: %+v %v", started, err)
			}
			var logs []string
			for {
				frame, err := events.Read(connection)
				if err != nil {
					t.Fatal(err)
				}
				if frame.Kind == "log" {
					logs = append(logs, frame.Line)
				}
				if frame.Kind == "exited" {
					if *frame.ExitCode != 7 {
						t.Fatalf("exit code: %d", *frame.ExitCode)
					}
					break
				}
			}
			output := strings.Join(logs, "\n")
			if !strings.Contains(output, "final-partial") || !strings.Contains(output, "instance="+started.ProcessInstance) {
				t.Fatalf("lost logs or identity: %s", output)
			}
			assertNativeExited(t, retained)
			var code uint32
			if err := windows.GetExitCodeProcess(retained, &code); err != nil || code != 0 {
				t.Fatalf("worker exit: %d %v", code, err)
			}
		})
	}
}

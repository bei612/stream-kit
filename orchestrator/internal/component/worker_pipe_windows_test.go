//go:build windows

package component

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/workeripc"
	"golang.org/x/sys/windows"
)

func TestNativePipeWorkerHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg == "--" {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if err := RunWorker(ctx, os.Args[i+1:]); err != nil {
				os.Exit(32)
			}
			os.Exit(0)
		}
	}
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
	creation, err := workeripc.ProcessCreation(windows.CurrentProcess())
	if err != nil {
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
			snapshot := workerLaunch{Instance: instance, Component: config.ComponentConfig{ExePath: os.Args[0], Args: "-test.run=^TestWorkerChild$", WorkingDir: filepath.Dir(os.Args[0]), Env: map[string]string{"STREAM_KIT_WORKER_TEST": "exit"}}}
			data, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			launchPath := filepath.Join(t.TempDir(), "launch.json")
			if err := os.WriteFile(launchPath, data, 0600); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(data)
			args := []string{"-test.run=^TestNativePipeWorkerHelper$", "--", "--pipe", listener.Name(), "--instance", instance, "--controller-pid", strconv.Itoa(os.Getpid()), "--controller-created", strconv.FormatUint(creation, 10), "--controller-sid", user.User.Sid.String(), "--controller-session", strconv.FormatUint(uint64(session), 10), "--launch-file", launchPath, "--launch-sha256", hex.EncodeToString(digest[:])}
			workerExe := os.Args[0]
			// Optional built-artifact acceptance exercises main's real dispatch.
			if binary := os.Getenv("STREAM_KIT_TEST_WORKER_BINARY"); binary != "" {
				workerExe = binary
				args = append([]string{"render-worker"}, args[2:]...)
			}
			worker, err := createSuspendedWorker(workerExe, args, filepath.Dir(workerExe),
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

func TestNativeControllerRejectsWrongPeer(t *testing.T) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	var session uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &session); err != nil {
		t.Fatal(err)
	}
	creation, err := workeripc.ProcessCreation(windows.CurrentProcess())
	if err != nil {
		t.Fatal(err)
	}
	controller, err := workeripc.RetainPeerProcess(uint32(os.Getpid()), creation)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(controller)
	for _, mode := range []string{"session", "sid", "process"} {
		t.Run(mode, func(t *testing.T) {
			var nonce [16]byte
			if _, err := rand.Read(nonce[:]); err != nil {
				t.Fatal(err)
			}
			listener, err := workeripc.Listen(hex.EncodeToString(nonce[:]), sid)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			expectedSID, expectedSession, expectedProcess := sid, session, controller
			switch mode {
			case "session":
				expectedSession++
			case "sid":
				expectedSID = "S-1-5-21-1-2-3-9999"
			case "process":
				other, err := nativeTestWorker(filepath.Join(t.TempDir(), "unused.pid"))
				if err != nil {
					t.Fatal(err)
				}
				defer other.Close()
				expectedProcess = other.process
			}
			type accepted struct {
				file *os.File
				err  error
			}
			result := make(chan accepted, 1)
			go func() { file, err := listener.Accept(ctx); result <- accepted{file, err} }()
			connection, dialErr := dialNativeController(ctx, listener.Name(), expectedProcess, expectedSID, expectedSession)
			if connection != nil {
				_ = connection.Close()
			}
			server := <-result
			if server.file != nil {
				defer server.file.Close()
			}
			if server.err != nil {
				t.Fatal(server.err)
			}
			if connection != nil || !errors.Is(dialErr, workeripc.ErrPeerIdentity) {
				t.Fatalf("wrong server accepted: %v", dialErr)
			}
		})
	}
}

//go:build windows

package component

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"go.uber.org/zap"
	"golang.org/x/sys/windows"
)

func TestNativePipeWorkerHelper(t *testing.T) {
	var pipe, instance string
	var parentPID, creation, session uint64
	var sid string
	for i, arg := range os.Args {
		if arg == "--" && i+6 < len(os.Args) {
			pipe, instance = os.Args[i+1], os.Args[i+2]
			var err error
			parentPID, err = strconv.ParseUint(os.Args[i+3], 10, 32)
			if err != nil {
				os.Exit(33)
			}
			creation, err = strconv.ParseUint(os.Args[i+4], 10, 64)
			if err != nil {
				os.Exit(33)
			}
			sid = os.Args[i+5]
			session, err = strconv.ParseUint(os.Args[i+6], 10, 32)
			if err != nil {
				os.Exit(33)
			}
			break
		}
	}
	if pipe == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	controller, err := workeripc.RetainPeerProcess(uint32(parentPID), creation)
	if err != nil {
		os.Exit(34)
	}
	defer windows.CloseHandle(controller)
	connection, err := dialNativeController(ctx, pipe, controller, sid, uint32(session))
	if err != nil {
		os.Exit(31)
	}
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
			worker, err := createSuspendedWorker(os.Args[0], []string{"-test.run=^TestNativePipeWorkerHelper$", "--", listener.Name(), instance, strconv.Itoa(os.Getpid()), strconv.FormatUint(creation, 10), user.User.Sid.String(), strconv.FormatUint(uint64(session), 10)}, filepath.Dir(os.Args[0]),
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

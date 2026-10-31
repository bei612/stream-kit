//go:build windows

package workeripc

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func pipeIdentity(t *testing.T) (string, string) {
	t.Helper()
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(nonce[:]), user.User.Sid.String()
}

func TestPrivatePipeRoundTripAndOwnership(t *testing.T) {
	instance, sid := pipeIdentity(t)
	listener, err := Listen(instance, sid)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if duplicate, err := Listen(instance, sid); err == nil {
		duplicate.Close()
		t.Fatal("duplicate server acquired same pipe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		file *os.File
		err  error
	}
	accepted := make(chan result, 1)
	go func() { file, err := listener.Accept(ctx); accepted <- result{file, err} }()
	client, err := Dial(ctx, listener.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	serverResult := <-accepted
	if serverResult.err != nil {
		t.Fatal(serverResult.err)
	}
	server := serverResult.file
	defer server.Close()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	} // connection ownership already moved
	deadline := time.Now().Add(3 * time.Second)
	if err := server.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	if err := client.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(process)
	var session uint32
	if err := windows.ProcessIdToSessionId(uint32(os.Getpid()), &session); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []struct {
		file *os.File
		side PeerSide
	}{{server, ClientPeer}, {client, ServerPeer}} {
		raw, err := endpoint.file.SyscallConn()
		if err != nil {
			t.Fatal(err)
		}
		var verification error
		if err := raw.Control(func(handle uintptr) {
			verification = VerifyPeer(windows.Handle(handle), endpoint.side, process, sid, session)
		}); err != nil {
			t.Fatal(err)
		}
		if verification != nil {
			t.Fatal(verification)
		}
	}
	writer, _ := New(instance, Commands)
	reader, _ := New(instance, Commands)
	if err := writer.Write(client, Frame{Kind: "ping"}); err != nil {
		t.Fatal(err)
	}
	if frame, err := reader.Read(server); err != nil || frame.Kind != "ping" {
		t.Fatalf("frame=%+v err=%v", frame, err)
	}
	// Closing the File must cancel pending reads through the runtime poller.
	readDone := make(chan error, 1)
	go func() { var b [1]byte; _, err := server.Read(b[:]); readDone <- err }()
	server.Close()
	select {
	case err := <-readDone:
		if err == nil {
			t.Fatal("closed read succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("close did not release pending read")
	}
}

func TestPrivatePipeAcceptCancellationAndClose(t *testing.T) {
	for _, mode := range []string{"context", "listener"} {
		t.Run(mode, func(t *testing.T) {
			instance, sid := pipeIdentity(t)
			listener, err := Listen(instance, sid)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				file, err := listener.Accept(ctx)
				if file != nil {
					file.Close()
				}
				done <- err
			}()
			// Ensure cancellation reaches an actual pending native connect, not
			// merely the preflight check before Accept starts.
			for {
				listener.mu.Lock()
				pending := listener.accepting
				listener.mu.Unlock()
				if pending {
					break
				}
				if ctx.Err() != nil {
					t.Fatal("accept never registered native operation")
				}
				time.Sleep(time.Millisecond)
			}
			if mode == "context" {
				cancel()
			} else {
				if err := listener.Close(); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) && !errors.Is(err, os.ErrClosed) {
					t.Fatalf("error=%v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("accept did not cancel")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	instance, _ := pipeIdentity(t)
	if _, err := Dial(ctx, pipePrefix+instance); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := Dial(context.Background(), `\\remote\pipe\stream-kit-worker-`+instance); !errors.Is(err, ErrProtocol) {
		t.Fatal("remote path accepted")
	}
}

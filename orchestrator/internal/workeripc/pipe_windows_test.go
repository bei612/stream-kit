//go:build windows

package workeripc

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestPrivatePipeConcurrentReadWrite(t *testing.T) {
	instance, sid := pipeIdentity(t)
	listener, err := Listen(instance, sid)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	type accepted struct {
		connection *Conn
		err        error
	}
	ready := make(chan accepted, 1)
	go func() { connection, err := listener.Accept(ctx); ready <- accepted{connection, err} }()
	client, err := Dial(ctx, listener.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-ready
	if server.err != nil {
		t.Fatal(server.err)
	}
	defer server.connection.Close()
	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	_ = server.connection.SetDeadline(time.Now().Add(10 * time.Second))
	done := make(chan error, 4)
	for _, direction := range []struct {
		sender, receiver *Conn
		value            byte
	}{
		{client, server.connection, 'a'}, {server.connection, client, 'b'},
	} {
		go func() {
			block := bytes.Repeat([]byte{direction.value}, 8192)
			for range 128 {
				if err := writeAll(direction.sender, block); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}()
		go func() {
			block := make([]byte, 8192)
			expected := bytes.Repeat([]byte{direction.value}, len(block))
			for range 128 {
				if _, err := io.ReadFull(direction.receiver, block); err != nil {
					done <- err
					return
				}
				if !bytes.Equal(block, expected) {
					done <- errors.New("concurrent pipe data corrupted")
					return
				}
			}
			done <- nil
		}()
	}
	for range 4 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if err := client.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	var one [1]byte
	if _, err := client.Read(one[:]); !os.IsTimeout(err) {
		t.Fatalf("missing read deadline: %v", err)
	}
	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := server.connection.Write([]byte{99}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(client, one[:]); err != nil || one[0] != 99 {
		t.Fatalf("deadline recovery: %v", err)
	}
}

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
		file *Conn
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
		file *Conn
		side PeerSide
	}{{server, ClientPeer}, {client, ServerPeer}} {
		if err := endpoint.file.WithHandle(func(handle windows.Handle) error { return VerifyPeer(handle, endpoint.side, process, sid, session) }); err != nil {
			t.Fatal(err)
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
	// Closing the connection must cancel pending reads through IOCP.
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

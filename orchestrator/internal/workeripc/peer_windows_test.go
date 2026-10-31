//go:build windows

package workeripc

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestRetainPeerRejectsStaleCreation(t *testing.T) {
	created, err := ProcessCreation(windows.CurrentProcess())
	if err != nil || created == 0 {
		t.Fatalf("creation: %d %v", created, err)
	}
	process, err := RetainPeerProcess(uint32(os.Getpid()), created)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(process)
	if process == windows.CurrentProcess() || !processRunning(process) {
		t.Fatal("did not retain a real live handle")
	}
	for _, bad := range []uint64{0, created - 1, created + 1} {
		process, err := RetainPeerProcess(uint32(os.Getpid()), bad)
		if err == nil || process != 0 {
			t.Fatalf("stale identity accepted: %d", bad)
		}
	}
	if process, err := RetainPeerProcess(0, created); err == nil || process != 0 {
		t.Fatal("zero PID accepted")
	}
}

func TestNamedPipePeerIdentity(t *testing.T) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
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
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(`\\.\pipe\stream-kit-peer-test-` + hex.EncodeToString(nonce[:]))
	if err != nil {
		t.Fatal(err)
	}
	server, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(server)
	client, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(client)
	if err := windows.ConnectNamedPipe(server, nil); err != nil && !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		pipe windows.Handle
		side PeerSide
	}{{server, ClientPeer}, {client, ServerPeer}} {
		if err := VerifyPeer(tc.pipe, tc.side, process, sid, session); err != nil {
			t.Fatal(err)
		}
		for _, wrong := range []struct {
			sid     string
			session uint32
		}{{sid, session + 1}, {"S-1-0-0", session}, {"invalid", session}} {
			if err := VerifyPeer(tc.pipe, tc.side, process, wrong.sid, wrong.session); !errors.Is(err, ErrPeerIdentity) {
				t.Fatalf("mismatch accepted: %v", err)
			}
		}
		if err := VerifyPeer(tc.pipe, tc.side, windows.InvalidHandle, sid, session); !errors.Is(err, ErrPeerIdentity) {
			t.Fatal("invalid process accepted")
		}
	}
	// A different live child has the same user and session, but is not this pipe peer.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(exe, "-test.run=^TestPipeIdentityChild$")
	child.Env = append(os.Environ(), "STREAM_KIT_PIPE_IDENTITY_CHILD=1")
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); _ = child.Wait() }()
	other, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(child.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(other)
	if err := VerifyPeer(server, ClientPeer, other, sid, session); !errors.Is(err, ErrPeerIdentity) {
		t.Fatal("different live process accepted")
	}
	_ = stdin.Close()
	if status, err := windows.WaitForSingleObject(other, 3000); err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("child did not exit: %d %v", status, err)
	}
	if processRunning(other) {
		t.Fatal("exited process is still reported running")
	}
}

func TestPipeIdentityChild(t *testing.T) {
	if os.Getenv("STREAM_KIT_PIPE_IDENTITY_CHILD") != "1" {
		return
	}
	var value [1]byte
	_, _ = os.Stdin.Read(value[:])
	os.Exit(0)
}

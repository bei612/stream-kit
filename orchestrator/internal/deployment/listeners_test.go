package deployment

import (
	"net"
	"strconv"
	"strings"
	"testing"
)

func TestListenerPreflightRejectsBusyNativeTCPAndUDPPorts(t *testing.T) {
	for _, network := range []string{"tcp4", "udp4"} {
		t.Run(network, func(t *testing.T) {
			var port int
			if network == "tcp4" {
				socket, err := net.Listen(network, "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer socket.Close()
				port = socket.Addr().(*net.TCPAddr).Port
			} else {
				socket, err := net.ListenPacket(network, "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer socket.Close()
				port = socket.LocalAddr().(*net.UDPAddr).Port
			}
			err := checkListenerSet([]deploymentListener{{"test", network, port}})
			if err == nil || !strings.Contains(err.Error(), strconv.Itoa(port)) || !strings.Contains(err.Error(), network) {
				t.Fatalf("busy listener not diagnosed: %v", err)
			}
		})
	}
}

func TestListenerPreflightReleasesHeldSocketsAfterFailure(t *testing.T) {
	// The duplicate intentionally fails after the first socket is acquired.
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	listener := deploymentListener{"test", "tcp4", port}
	if checkListenerSet([]deploymentListener{listener, listener}) == nil {
		t.Fatal("duplicate native bind accepted")
	}
	if err := checkListenerSet([]deploymentListener{listener}); err != nil {
		t.Fatalf("preflight retained listener: %v", err)
	}
}

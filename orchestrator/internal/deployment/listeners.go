package deployment

import (
	"fmt"
	"io"
	"net"
)

type deploymentListener struct {
	component, network string
	port               int
}

func initialListeners(options Options) []deploymentListener {
	return []deploymentListener{
		{"control", "tcp4", options.ControlPort},
		{"gateway", "tcp4", options.GatewayPort},
		{"renderer HTTPS", "tcp4", options.RendererPort - 5},
		{"renderer HTTP", "tcp4", options.RendererPort},
		{"renderer management", "tcp4", options.RendererPort + 1},
		{"renderer RTSP", "tcp4", options.RendererPort + 21},
		{"renderer video", "udp4", options.RendererPort + 9},
		{"renderer control", "udp4", options.RendererPort + 10},
		{"renderer audio", "udp4", options.RendererPort + 11},
	}
}

// Check all native listeners before preparing credentials or runtime storage.
// This is a bounded availability check, not a reservation across service start;
// the startup readiness check still detects later races and runtime failures.
func checkListeners(options Options) error {
	if err := options.normalizePorts(); err != nil {
		return err
	}
	return checkListenerSet(initialListeners(options))
}

func checkListenerSet(listeners []deploymentListener) error {
	var held []io.Closer
	defer func() {
		for _, socket := range held {
			socket.Close()
		}
	}()
	for _, listener := range listeners {
		address := fmt.Sprintf("127.0.0.1:%d", listener.port)
		var socket io.Closer
		var err error
		if listener.network == "tcp4" {
			socket, err = net.Listen(listener.network, address)
		} else {
			socket, err = net.ListenPacket(listener.network, address)
		}
		if err != nil {
			return fmt.Errorf("%s listener %s %s unavailable; choose different installation ports: %w", listener.component, listener.network, address, err)
		}
		held = append(held, socket)
	}
	return nil
}

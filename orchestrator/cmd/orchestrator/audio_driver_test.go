package main

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/stream-kit/orchestrator/internal/audiodevice"
	"github.com/stream-kit/orchestrator/internal/config"
)

func TestInstallerAudioPreparationUsesConfiguredGateway(t *testing.T) {
	gateway := config.ComponentConfig{ExePath: "configured-gateway.exe", WindowsUserSID: "S-1-5-21-1-2-3-1001"}
	cfg := &config.Config{Components: map[string]config.ComponentConfig{"web_server": gateway}}
	for _, want := range []error{nil, fmt.Errorf("device: %w", audiodevice.ErrRestartRequired), errors.New("preparation failed")} {
		called := false
		err := prepareConfiguredGatewayAudio(context.Background(), cfg, func(ctx context.Context, name string, got config.ComponentConfig) error {
			called = true
			if name != "web_server" || got.ExePath != gateway.ExePath || got.WindowsUserSID != gateway.WindowsUserSID {
				t.Fatalf("wrong component: %s %+v", name, got)
			}
			return want
		})
		if !called || err != want || errors.Is(err, errAudioDriverRestartRequired) != errors.Is(want, audiodevice.ErrRestartRequired) {
			t.Fatalf("preparation outcome lost: called=%v got=%v want=%v", called, err, want)
		}
	}
}

func TestInstallerAudioPreparationRejectsMissingGatewayIdentity(t *testing.T) {
	for _, components := range []map[string]config.ComponentConfig{
		nil,
		{"web_server": {ExePath: "gateway.exe"}},
		{"web_server": {WindowsUserSID: "S-1-5-21-1-2-3-1001"}},
	} {
		called := false
		err := prepareConfiguredGatewayAudio(context.Background(), &config.Config{Components: components}, func(context.Context, string, config.ComponentConfig) error {
			called = true
			return nil
		})
		if err == nil || called {
			t.Fatalf("invalid gateway invoked device preparation: err=%v called=%v", err, called)
		}
	}
}

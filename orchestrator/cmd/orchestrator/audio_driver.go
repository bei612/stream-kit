package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/audiodevice"
	"github.com/stream-kit/orchestrator/internal/config"
	"os"
	"runtime"
	"time"
)

var errAudioDriverRestartRequired = audiodevice.ErrRestartRequired

func audioDriverCommand(args []string) error {
	if len(args) > 0 && (args[0] == "prepare" || args[0] == "restore-legacy-policy") {
		if runtime.GOOS != "windows" {
			return fmt.Errorf("audio-driver %s is only supported on Windows", args[0])
		}
		if len(args) != 3 || args[1] != "--config" || args[2] == "" {
			return fmt.Errorf("usage: orchestrator audio-driver %s --config CONFIG_FILE", args[0])
		}
		cfg, err := config.LoadExisting(args[2])
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if args[0] == "restore-legacy-policy" {
			return prepareConfiguredGatewayAudio(ctx, cfg, restoreLegacyComponentAudio)
		}
		return prepareConfiguredGatewayAudio(ctx, cfg, prepareComponentAudio)
	}
	if len(args) != 2 || (args[0] != "verify" && args[0] != "install") {
		return fmt.Errorf("usage: orchestrator audio-driver verify|install PACKAGE_DIRECTORY")
	}
	if args[0] == "verify" {
		if err := audiodevice.VerifyUSBDriverPackage(args[1]); err != nil {
			return err
		}
		fmt.Println("Reviewed USB audio driver package verified; no devices installed or changed")
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := audiodevice.InstallWindowsDriver(ctx, args[1])
	if err != nil {
		return err
	}
	if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return err
	}
	if result.RestartRequired {
		return errAudioDriverRestartRequired
	}
	return nil
}

// Setup uses the same resource preparation as service startup, before registering
// the service. No listener or streaming process is started by this command.
func prepareConfiguredGatewayAudio(ctx context.Context, cfg *config.Config, prepare func(context.Context, string, config.ComponentConfig) error) error {
	gateway, ok := cfg.Components["web_server"]
	if !ok || gateway.ExePath == "" || gateway.WindowsUserSID == "" {
		return fmt.Errorf("audio preparation requires a configured Windows gateway")
	}
	return prepare(ctx, "web_server", gateway)
}

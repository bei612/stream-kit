package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/audiodevice"
	"os"
	"time"
)

var errAudioDriverRestartRequired = errors.New("audio driver installation requires a manual restart")

func audioDriverCommand(args []string) error {
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

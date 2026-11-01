package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/audiodevice"
	"os"
	"runtime"
	"time"
)

func prepareAudio(args []string, release bool) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: orchestrator prepare-audio|release-audio")
	}
	if runtime.GOOS != "linux" {
		return fmt.Errorf("automatic virtual audio provisioning is currently available on Linux only")
	}
	if os.Getuid() == 0 {
		return fmt.Errorf("run as the desktop/audio session owner, not root")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if release {
		return audiodevice.ReleasePulse(ctx, audiodevice.Pactl)
	}
	pair, err := audiodevice.EnsurePulse(ctx, audiodevice.Pactl)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(pair)
}

//go:build windows

// CI-only caller of production device preparation. Never a runtime executable.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/stream-kit/orchestrator/internal/audiodevice"
	"golang.org/x/sys/windows"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 || os.Getenv("GITHUB_ACTIONS") != "true" || os.Getenv("RUNNER_ENVIRONMENT") != "github-hosted" || os.Getenv("RUNNER_OS") != "Windows" || !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("endpoint-policy check requires the elevated disposable GitHub Windows fixture")
	}
	id := audiodevice.WindowsIdentity{VendorID: 65534, ProductID: 1, Serial: "CIPolicyTarget"}
	ready, err := audiodevice.WindowsPolicyReady(id)
	if err != nil {
		return err
	}
	if ready {
		return errors.New("fixture was already prepared")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	prepare := func() error {
		return audiodevice.PrepareWindowsGateway(ctx, os.Args[1], []string{"--config-path", os.Args[2], "prepare-audio"}, "", nil)
	}
	if err := prepare(); err != nil {
		return err
	}
	ready, err = audiodevice.WindowsPolicyReady(id)
	if err != nil {
		return err
	}
	if !ready {
		return errors.New("production preparation did not persist completion")
	}
	if err := prepare(); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "production_policy": true, "native_gateway_preparation": true, "repeat_preparation_passed": true})
}

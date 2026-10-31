package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/stream-kit/orchestrator/internal/bundle"
	"github.com/stream-kit/orchestrator/internal/windowsservice"
)

func serviceCommand(args []string) error {
	if len(args) != 3 || args[1] != "--config" {
		return fmt.Errorf("usage: orchestrator service install|start|stop|remove --config PATH")
	}
	operation := args[0]
	if operation != "install" && operation != "start" && operation != "stop" && operation != "remove" {
		return fmt.Errorf("unknown service operation %q", operation)
	}
	configPath, err := configArgument(args[1:])
	if err != nil {
		return err
	}
	configPath, err = filepath.Abs(configPath)
	if err != nil {
		return err
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	if operation == "install" || operation == "start" {
		if _, err := bundle.Verify(filepath.Dir(binary), runtime.GOOS, runtime.GOARCH); err != nil {
			return err
		}
		if err := checkConfig(configPath); err != nil {
			return err
		}
	}
	if err := windowsservice.Apply(operation, binary, configPath); err != nil {
		return err
	}
	fmt.Printf("StreamKitOrchestrator service %s completed\n", operation)
	return nil
}

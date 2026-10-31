package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

const commandUsage = "usage: orchestrator [--config PATH] | init-config [--config PATH] | init-platform --root DIRECTORY --data-dir NEW_DIRECTORY --user-sid SID --session-id ID | print-config [--config PATH] | check-config [--config PATH] | version | verify-bundle DIRECTORY | service install|start|stop|remove --config PATH"

func argumentError(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(2)
}

// configArgument is shared by service startup and configuration inspection.
// Reject ambiguous or unknown arguments before loading or generating any files.
func configArgument(args []string) (string, error) {
	if len(args) == 0 {
		return "config.json", nil
	}
	var path string
	switch {
	case len(args) == 2 && args[0] == "--config" && !strings.HasPrefix(args[1], "-"):
		path = args[1]
	case len(args) == 1 && strings.HasPrefix(args[0], "--config="):
		path = strings.TrimPrefix(args[0], "--config=")
	default:
		return "", errors.New(commandUsage)
	}
	if strings.TrimSpace(path) == "" || strings.ContainsRune(path, 0) {
		return "", errors.New("configuration path must not be empty or contain NUL")
	}
	return path, nil
}

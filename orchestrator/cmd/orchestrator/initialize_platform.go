package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/stream-kit/orchestrator/internal/deployment"
)

func initializePlatform(args []string) error {
	flags := flag.NewFlagSet("init-platform", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("root", "", "installed platform directory")
	data := flags.String("data-dir", "", "new external data directory")
	sid := flags.String("user-sid", "", "interactive rendering user SID")
	session := flags.Uint64("session-id", 0, "interactive rendering session")
	adminFile := flags.String("admin-file", "", "protected JSON file containing administrator name and password")
	controlPort := flags.Int("control-port", 9000, "control listener port")
	gatewayPort := flags.Int("gateway-port", 8080, "gateway listener port")
	rendererPort := flags.Int("renderer-port", 47989, "renderer base port")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *root == "" || *data == "" {
		return fmt.Errorf("init-platform requires --root DIRECTORY and --data-dir NEW_DIRECTORY")
	}
	if *sid == "" && *session == 0 {
		current, user, err := deployment.CurrentRenderIdentity()
		if err != nil {
			return err
		}
		*sid, *session = user, uint64(current)
	}
	if flags.NArg() != 0 || *root == "" || *data == "" || *sid == "" || *session == 0 || *session >= 1<<32-1 {
		return fmt.Errorf("usage: orchestrator init-platform --root DIRECTORY --data-dir NEW_DIRECTORY --user-sid SID --session-id ID")
	}
	options := deployment.Options{Root: *root, Data: *data, Commit: commit, SessionID: uint32(*session), UserSID: *sid, ControlPort: *controlPort, GatewayPort: *gatewayPort, RendererPort: *rendererPort}
	if *adminFile != "" {
		name, password, err := readAdministrator(*adminFile)
		if err != nil {
			return err
		}
		options.AdminName, options.AdminPassword = name, password
	}
	file, err := deployment.Initialize(context.Background(), options)
	if err != nil {
		return err
	}
	fmt.Printf("Platform configuration prepared at %s; retrieve administrator credentials from this protected file. No service started.\n", file)
	return nil
}

func readAdministrator(path string) (string, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 16385))
	if err != nil || len(data) > 16384 {
		return "", "", fmt.Errorf("administrator file is unreadable or too large")
	}
	var value struct {
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if json.Unmarshal(data, &value) != nil || value.Name == "" || value.Password == "" {
		return "", "", fmt.Errorf("administrator file must contain JSON name and password fields")
	}
	if err := deployment.ValidateAdministrator(value.Name, value.Password); err != nil {
		return "", "", err
	}
	return value.Name, value.Password, nil
}

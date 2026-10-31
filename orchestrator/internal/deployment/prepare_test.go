package deployment

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/commandline"
	"github.com/stream-kit/orchestrator/internal/config"
)

func TestPreparationConnectsNativeComponentsWithoutExposingSecretsInArguments(t *testing.T) {
	previous := config.BaseDir
	t.Cleanup(func() { config.BaseDir = previous })
	base := t.TempDir()
	root, data, stage := filepath.Join(base, "program files"), filepath.Join(base, "data"), filepath.Join(base, "staging")
	for _, dir := range []string{stage, filepath.Join(stage, "gateway"), filepath.Join(stage, "sunshine")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	opts := Options{SessionID: 1, UserSID: "S-1-5-21-123-456-789-1001"}
	var operations []string
	var credentials map[string]string
	run := func(_ context.Context, binary, directory string, args []string, input []byte) ([]byte, error) {
		if directory != stage {
			t.Fatal("bootstrap wrote into the immutable program directory")
		}
		operation := args[len(args)-1]
		operations = append(operations, operation)
		if operation == "print" {
			return []byte(`{"web_server":{},"data_storage":{"type":"json"}}`), nil
		}
		if operation == "initialize-admin" || operation == "--creds-stdin" {
			var next map[string]string
			if err := json.Unmarshal(input, &next); err != nil {
				t.Fatal(err)
			}
			if len(next["password"]) < 32 || strings.Contains(strings.Join(args, " "), next["password"]) {
				t.Fatal("secret missing or exposed in argv")
			}
			if credentials != nil && credentials["password"] != next["password"] {
				t.Fatal("internal component credentials differ")
			}
			credentials = next
		}
		return nil, nil
	}
	if err := prepareFiles(context.Background(), opts, root, data, stage, run); err != nil {
		t.Fatal(err)
	}
	if strings.Join(operations, ",") != "print,initialize-admin,check,--creds-stdin" {
		t.Fatalf("wrong lifecycle: %v", operations)
	}
	loaded, err := config.LoadExisting(filepath.Join(stage, "orchestrator.json"))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.MoonlightWeb.Password != credentials["password"] || loaded.SunshineAPI.Password != credentials["password"] || loaded.Server.Password == credentials["password"] {
		t.Fatal("administrator/internal identity isolation failed")
	}
	if loaded.Storage.DBPath != filepath.Join(data, "data", "orchestrator.db") {
		t.Fatal("database must remain external")
	}
	var gateway map[string]any
	raw, _ := os.ReadFile(filepath.Join(stage, "gateway", "config.json"))
	if err := json.Unmarshal(raw, &gateway); err != nil {
		t.Fatal(err)
	}
	web := gateway["web_server"].(map[string]any)
	if web["media_ticket_secret"] != loaded.Server.MediaTicketSecret || web["first_login_create_admin"] != false {
		t.Fatal("gateway authority not initialized securely")
	}
	for name, component := range loaded.Components {
		args, err := commandline.Parse(component.Args)
		if err != nil {
			t.Fatal(err)
		}
		if len(args) == 0 || !component.AutoStart || component.WindowsUserSID != opts.UserSID || component.WindowsSessionID != opts.SessionID {
			t.Fatal("component not prepared", name)
		}
	}
	for _, file := range []string{"orchestrator.json", filepath.Join("gateway", "config.json"), filepath.Join("sunshine", "sunshine.conf")} {
		raw, err := os.ReadFile(filepath.Join(stage, file))
		if err != nil {
			t.Fatal(err)
		}
		// JSON escapes Windows slashes; check both native configuration encodings.
		for _, forbidden := range []string{stage, filepath.ToSlash(stage), strings.ReplaceAll(stage, `\`, `\\`)} {
			if bytes.Contains(raw, []byte(forbidden)) {
				t.Fatal("staging path persisted in final configuration", file)
			}
		}
	}
}

func TestPreparationStopsAtNativeFailure(t *testing.T) {
	previous := config.BaseDir
	t.Cleanup(func() { config.BaseDir = previous })
	stage := t.TempDir()
	want := errors.New("native bootstrap refused")
	calls := 0
	err := prepareFiles(context.Background(), Options{SessionID: 1, UserSID: "S-1-5-21-1-2-3-1001"}, filepath.Join(stage, "program"), filepath.Join(stage, "external"), stage,
		func(context.Context, string, string, []string, []byte) ([]byte, error) { calls++; return nil, want })
	if !errors.Is(err, want) || calls != 1 {
		t.Fatalf("continued after failed native operation: %v, calls %d", err, calls)
	}
}

func TestProgramAndDataMustNotOverlap(t *testing.T) {
	base := t.TempDir()
	for _, pair := range [][2]string{{base, base}, {base, filepath.Join(base, "data")}, {filepath.Join(base, "program"), base}, {base + "\n", filepath.Join(base, "sibling")}} {
		if validateLocation(pair[0], pair[1]) == nil {
			t.Fatal("unsafe layout accepted", pair)
		}
	}
	if err := validateLocation(filepath.Join(base, "program"), filepath.Join(base, "data")); err != nil {
		t.Fatal(err)
	}
}

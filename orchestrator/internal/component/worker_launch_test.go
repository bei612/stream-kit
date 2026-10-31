package component

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
)

func TestWorkerLaunchSnapshotValidation(t *testing.T) {
	const instance = "0123456789abcdef0123456789abcdef"
	dir := t.TempDir()
	base := workerLaunch{Instance: instance, Component: config.ComponentConfig{ExePath: filepath.Join(dir, "renderer.exe"), WorkingDir: dir, Args: `--name "render app"`, Env: map[string]string{"TOKEN": "private-value"}}}
	valid, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"valid", "tampered", "instance", "unknown", "trailing", "oversized", "relative", "args"} {
		t.Run(mode, func(t *testing.T) {
			data := append([]byte(nil), valid...)
			expectedInstance := instance
			switch mode {
			case "instance":
				expectedInstance = strings.Repeat("f", 32)
			case "unknown":
				data = append([]byte(`{"unknown":true,`), valid[1:]...)
			case "trailing":
				data = append(data, []byte(` {}`)...)
			case "oversized":
				data = []byte(strings.Repeat(" ", (1<<20)+1))
			case "relative":
				changed := base
				changed.Component.ExePath = "relative.exe"
				data, _ = json.Marshal(changed)
			case "args":
				changed := base
				changed.Component.Args = `"unterminated`
				data, _ = json.Marshal(changed)
			}
			hash := sha256.Sum256(data)
			if mode == "tampered" {
				data = append(data, ' ')
			}
			path := filepath.Join(dir, mode+".json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			cfg, err := readWorkerLaunch(path, hex.EncodeToString(hash[:]), expectedInstance)
			if mode == "valid" {
				if err != nil || cfg.ExePath != base.Component.ExePath || cfg.Env["TOKEN"] != "private-value" {
					t.Fatal("valid snapshot lost configuration", err)
				}
			} else if !errors.Is(err, errWorkerLaunch) || strings.Contains(err.Error(), "private-value") {
				t.Fatalf("invalid snapshot not safely rejected: %v", err)
			}
		})
	}
}

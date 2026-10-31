package component

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"

	"github.com/stream-kit/orchestrator/internal/commandline"
	"github.com/stream-kit/orchestrator/internal/config"
)

// workerLaunch is an immutable, per-launch snapshot, never the full management
// configuration. The controller supplies its digest through trusted launch args.
type workerLaunch struct {
	Instance  string                 `json:"instance"`
	Component config.ComponentConfig `json:"component"`
}

var errWorkerLaunch = errors.New("invalid render worker launch snapshot")

const maxWorkerLaunchBytes = 1 << 20

func readWorkerLaunch(path, digest, instance string) (config.ComponentConfig, error) {
	var empty config.ComponentConfig
	if !filepath.IsAbs(path) || len(digest) != sha256.Size*2 {
		return empty, errWorkerLaunch
	}
	file, err := openWorkerLaunch(path)
	if err != nil {
		return empty, errWorkerLaunch
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return empty, errWorkerLaunch
	}
	data, err := io.ReadAll(io.LimitReader(file, maxWorkerLaunchBytes+1))
	if err != nil || len(data) > maxWorkerLaunchBytes {
		return empty, errWorkerLaunch
	}
	actual := sha256.Sum256(data)
	if hex.EncodeToString(actual[:]) != digest {
		return empty, errWorkerLaunch
	}
	var launch workerLaunch
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&launch) != nil || decoder.Decode(new(any)) != io.EOF || launch.Instance != instance {
		return empty, errWorkerLaunch
	}
	cfg := launch.Component
	if !filepath.IsAbs(cfg.ExePath) || !filepath.IsAbs(cfg.WorkingDir) {
		return empty, errWorkerLaunch
	}
	if _, err := commandline.Parse(cfg.Args); err != nil {
		return empty, errWorkerLaunch
	}
	if _, err := commandline.Parse(cfg.PreflightArgs); err != nil {
		return empty, errWorkerLaunch
	}
	return cfg, nil
}

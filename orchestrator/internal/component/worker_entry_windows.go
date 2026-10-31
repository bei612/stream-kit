//go:build windows

package component

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"path/filepath"

	"github.com/stream-kit/orchestrator/internal/workeripc"
	"go.uber.org/zap"
	"golang.org/x/sys/windows"
)

// RunWorker is the private child entry, reached before normal server startup.
// It authenticates the controller before reading the immutable launch snapshot.
// The service launcher must protect that snapshot with a user-read-only ACL and
// retain the worker's kill-on-close job throughout its lifetime.
func RunWorker(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("render-worker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	instance := flags.String("instance", "", "worker instance")
	pipe := flags.String("pipe", "", "private controller pipe")
	pid := flags.Uint64("controller-pid", 0, "controller process")
	created := flags.Uint64("controller-created", 0, "controller creation time")
	sid := flags.String("controller-sid", "", "controller account")
	session := flags.Uint64("controller-session", 0, "controller session")
	path := flags.String("launch-file", "", "immutable launch snapshot")
	digest := flags.String("launch-sha256", "", "snapshot digest")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *pid == 0 || *pid > uint64(^uint32(0)) || *session > uint64(^uint32(0)) {
		return errors.New("invalid render worker arguments")
	}
	if _, err := workeripc.New(*instance, workeripc.Commands); err != nil {
		return err
	}
	capability, err := openWorkerLaunch(filepath.Join(filepath.Dir(*path), "controller.json"))
	if err != nil {
		return err
	}
	info, err := capability.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		capability.Close()
		return workeripc.ErrPeerIdentity
	}
	var handles workeripc.ControllerHandles
	decoder := json.NewDecoder(io.LimitReader(capability, 4097))
	decoder.DisallowUnknownFields()
	readErr := decoder.Decode(&handles)
	if readErr == nil && decoder.Decode(new(any)) != io.EOF {
		readErr = workeripc.ErrPeerIdentity
	}
	closeErr := capability.Close()
	if readErr != nil || closeErr != nil {
		return workeripc.ErrPeerIdentity
	}
	controller, controllerToken, err := handles.Open(uint32(*pid), *created)
	if controller != 0 {
		defer windows.CloseHandle(controller)
	}
	if controllerToken != 0 {
		defer controllerToken.Close()
	}
	if err != nil {
		return err
	}
	connection, err := dialNativeController(ctx, *pipe, controller, controllerToken, *sid, uint32(*session))
	if err != nil {
		return err
	}
	defer connection.Close()
	cfg, err := readWorkerLaunch(*path, *digest, *instance)
	if err != nil {
		return err
	}
	return serveWorker(ctx, connection, *instance, func(logs *RingBuffer) (*ManagedProcess, error) {
		if err := preflight(ctx, cfg); err != nil {
			return nil, err
		}
		return StartProcess(cfg.ExePath, cfg.Args, cfg.WorkingDir, cfg.Env, logs, zap.NewNop())
	})
}

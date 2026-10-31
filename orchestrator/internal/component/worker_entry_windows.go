//go:build windows

package component

import (
	"context"
	"errors"
	"flag"
	"io"

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
	controller, err := workeripc.RetainPeerProcess(uint32(*pid), *created)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(controller)
	connection, err := dialNativeController(ctx, *pipe, controller, *sid, uint32(*session))
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

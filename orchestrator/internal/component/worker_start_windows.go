//go:build windows

package component

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/workeripc"
	"golang.org/x/sys/windows"
)

func startSessionWorker(ctx context.Context, cfg config.ComponentConfig, root string, session uint32, sid string, logs *RingBuffer) (*ManagedProcess, error) {
	token, err := openWorkerUser(session, sid)
	if err != nil {
		return nil, err
	}
	defer token.Close()
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return launchSessionWorker(ctx, cfg, root, session, sid, logs, func(args []string) (*nativeWorker, error) {
		return startNativeWorker(token, session, sid, exe, args, filepath.Dir(exe))
	}, func() error {
		current, err := openWorkerUser(session, sid)
		if err != nil {
			return err
		}
		return current.Close()
	})
}

// launchSessionWorker owns the complete launch transaction. The private spawn
// seam is shared by real native tests; production always uses the selected user
// token above. Once attached, ManagedProcess owns every resource until Done.
func launchSessionWorker(ctx context.Context, cfg config.ComponentConfig, root string, session uint32, sid string, logs *RingBuffer,
	spawn func([]string) (*nativeWorker, error),
	sessionGuard func() error,
) (_ *ManagedProcess, result error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	instance := hex.EncodeToString(nonce[:])
	if cfg.WorkingDir == "" {
		cfg.WorkingDir = filepath.Dir(cfg.ExePath)
	}
	snapshot, err := writeWorkerLaunch(root, instance, sid, cfg)
	if err != nil {
		return nil, err
	}
	var worker *nativeWorker
	var connection *workeripc.Conn
	defer func() {
		if result == nil {
			return
		}
		if connection != nil {
			result = errors.Join(result, connection.Close())
		}
		if worker != nil {
			waitWorkerTree(worker, func() error { return windows.TerminateJobObject(worker.job, 1) }, logs)
			result = errors.Join(result, worker.Close())
		}
		result = errors.Join(result, snapshot.Close())
	}()
	var controllerToken windows.Token
	if err = windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &controllerToken); err != nil {
		return nil, err
	}
	defer controllerToken.Close()
	controller, err := controllerToken.GetTokenUser()
	if err != nil {
		return nil, err
	}
	var controllerSession uint32
	if err = windows.ProcessIdToSessionId(uint32(os.Getpid()), &controllerSession); err != nil {
		return nil, err
	}
	creation, err := workeripc.ProcessCreation(windows.CurrentProcess())
	if err != nil {
		return nil, err
	}
	listener, err := workeripc.Listen(instance, sid)
	if err != nil {
		return nil, err
	}
	defer listener.Close()
	args := []string{"render-worker", "--pipe", listener.Name(), "--instance", instance,
		"--controller-pid", strconv.Itoa(os.Getpid()), "--controller-created", strconv.FormatUint(creation, 10),
		"--controller-sid", controller.User.Sid.String(), "--controller-session", strconv.FormatUint(uint64(controllerSession), 10),
		"--launch-file", snapshot.path, "--launch-sha256", snapshot.digest}
	worker, err = spawn(args)
	if err != nil {
		return nil, err
	}
	if err = snapshot.delegateController(worker.process, controllerToken); err != nil {
		return nil, err
	}
	connection, err = acceptNativeWorker(ctx, listener, worker, sid, session)
	if err != nil {
		// acceptNativeWorker already consumed the job on failed authentication.
		worker = nil
		return nil, err
	}
	return attachWorkerProcess(ctx, connection, instance, worker, snapshot, logs, sessionGuard)
}

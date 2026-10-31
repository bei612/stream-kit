//go:build windows

package component

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/workeripc"
	"golang.org/x/sys/windows"
)

type workerSnapshot struct {
	path      string
	digest    string
	directory string
	file      *os.File
}

func openWorkerLaunch(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// The service owns a delete-on-close handle. Readers must permit deletion
	// so an abrupt service exit does not leave a credential-bearing snapshot.
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), path), nil
}

// writeWorkerLaunch requires a trusted service-owned root. It creates only a
// new instance directory, never adopts an existing directory or file. The user
// gets read/traverse access; SYSTEM and the controller account own cleanup.
// Same-account console tests share that account's rights, but the held file
// handle still denies every competing writer. No handle is inherited.
func writeWorkerLaunch(root, instance, userSID string, cfg config.ComponentConfig) (_ *workerSnapshot, result error) {
	if !filepath.IsAbs(root) {
		return nil, errWorkerLaunch
	}
	if _, err := workeripc.New(instance, workeripc.Commands); err != nil {
		return nil, err
	}
	user, err := windows.StringToSid(userSID)
	if err != nil {
		return nil, errWorkerLaunch
	}
	var token windows.Token
	if err = windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	controller, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	launchConfig := config.ComponentConfig{ExePath: cfg.ExePath, Args: cfg.Args, PreflightArgs: cfg.PreflightArgs, WorkingDir: cfg.WorkingDir, Env: cfg.Env}
	data, err := json.Marshal(workerLaunch{Instance: instance, Component: launchConfig})
	if err != nil || len(data) > maxWorkerLaunchBytes {
		return nil, errWorkerLaunch
	}
	makeAttributes := func(access uint32) (*windows.SecurityAttributes, error) {
		sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("D:P(A;;FA;;;SY)(A;;FA;;;%s)(A;;0x%x;;;%s)", controller.User.Sid.String(), access, user.String()))
		if err != nil {
			return nil, err
		}
		return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
	}
	directoryAttributes, err := makeAttributes(windows.FILE_GENERIC_READ | windows.FILE_GENERIC_EXECUTE)
	if err != nil {
		return nil, err
	}
	fileAttributes, err := makeAttributes(windows.FILE_GENERIC_READ)
	if err != nil {
		return nil, err
	}
	directory := filepath.Join(root, "worker-"+instance)
	dirName, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return nil, err
	}
	if err = windows.CreateDirectory(dirName, directoryAttributes); err != nil {
		return nil, err
	}
	snapshot := &workerSnapshot{directory: directory, path: filepath.Join(directory, "launch.json")}
	defer func() {
		if result != nil {
			result = errors.Join(result, snapshot.Close())
		}
	}()
	name, err := windows.UTF16PtrFromString(snapshot.path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.DELETE, windows.FILE_SHARE_READ|windows.FILE_SHARE_DELETE, fileAttributes, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_TEMPORARY|windows.FILE_FLAG_DELETE_ON_CLOSE, 0)
	if err != nil {
		return nil, err
	}
	snapshot.file = os.NewFile(uintptr(h), snapshot.path)
	if _, err = snapshot.file.Write(data); err != nil {
		return nil, err
	}
	if err = snapshot.file.Sync(); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	snapshot.digest = hex.EncodeToString(digest[:])
	if _, err = readWorkerLaunch(snapshot.path, snapshot.digest, instance); err != nil {
		return nil, err
	}
	return snapshot, nil
}

// Close must follow worker teardown. Only the exact newly created empty
// directory is removed; foreign contents are never recursively deleted.
func (snapshot *workerSnapshot) Close() error {
	var result error
	if snapshot.file != nil {
		result = snapshot.file.Close()
		snapshot.file = nil
	}
	if snapshot.directory != "" {
		err := os.Remove(snapshot.directory)
		if err == nil || os.IsNotExist(err) {
			snapshot.directory = ""
		} else {
			result = errors.Join(result, err)
		}
	}
	return result
}

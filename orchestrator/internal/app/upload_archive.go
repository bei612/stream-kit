package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/model"
)

type UploadArchive struct {
	File    *os.File
	Path    string
	record  model.UploadArchive
	manager *Manager
}

func (m *Manager) uploadDirectory() (string, error) {
	if m.config.Storage.TempDir == "" {
		return "", errors.New("上传临时目录未配置")
	}
	root, err := filepath.Abs(m.config.Storage.TempDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(root)
}

// CreateUploadArchive persists ownership before callers may write the payload.
// A crash before that commit can leave only an empty file, never a large upload.
func (m *Manager) CreateUploadArchive(filename string) (*UploadArchive, error) {
	ext := ArchiveExtension(filename)
	if ext == "" {
		return nil, errors.New("上传归档格式无效")
	}
	directory, err := m.uploadDirectory()
	if err != nil {
		return nil, err
	}
	record := model.UploadArchive{ID: uuid.NewString(), Directory: directory, Extension: ext}
	path := filepath.Join(directory, "upload-"+record.ID+ext)
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	file, err := root.OpenFile(filepath.Base(path), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	if err := m.store.CreateUploadArchive(&record); err != nil {
		return nil, errors.Join(err, file.Close(), root.Remove(filepath.Base(path)))
	}
	return &UploadArchive{File: file, Path: path, record: record, manager: m}, nil
}

func (a *UploadArchive) Cleanup() error {
	return a.manager.removeUploadArchive(a.record)
}

func (m *Manager) removeUploadArchive(record model.UploadArchive) error {
	id, err := uuid.Parse(record.ID)
	if err != nil || id.String() != record.ID || ArchiveExtension("archive"+record.Extension) != record.Extension || record.Extension == "" {
		return errors.New("上传归档所有权记录无效")
	}
	current, err := m.store.GetUploadArchive(record.ID)
	if err != nil {
		return err
	}
	if current == nil {
		return nil
	}
	if current.Directory != record.Directory || current.Extension != record.Extension {
		return errors.New("上传归档所有权记录已改变，已保留")
	}
	directory, err := m.uploadDirectory()
	if err != nil {
		return err
	}
	same := directory == record.Directory
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(directory, record.Directory)
	}
	if !same {
		return errors.New("上传临时目录已改变，旧归档已保留，请恢复原临时目录后重试")
	}
	// Confine all operations to the opened directory, even if an ancestor is
	// replaced concurrently. Remove one regular file only; never recurse.
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	name := "upload-" + record.ID + record.Extension
	info, err := root.Lstat(name)
	if err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("上传归档已被替换为目录或链接，已保留")
		}
		if err := root.Remove(name); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// Missing files are expected if the process exited between unlink and commit.
	return m.store.DeleteUploadArchive(record.ID)
}

func (m *Manager) recoverUploadArchives() error {
	records, err := m.store.ListUploadArchives()
	if err != nil {
		return err
	}
	for _, record := range records {
		if err := m.removeUploadArchive(record); err != nil {
			return fmt.Errorf("回收上传归档 %s 失败: %w", record.ID, err)
		}
	}
	return nil
}

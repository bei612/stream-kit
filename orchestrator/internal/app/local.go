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

// AppDir always belongs to the platform, irrespective of the executable source.
// A local application's executable/working directory are references, never owned.
type LocalAppRequest struct {
	Name         string `json:"name"`
	ExePath      string `json:"exe_path"`
	WorkingDir   string `json:"working_dir"`
	Args         string `json:"args"`
	ArgsTemplate string `json:"args_template"`
}

var ErrInvalidLocalApp = errors.New("本机程序配置无效")

func canonicalLocalPath(name string, directory bool) (string, error) {
	if !filepath.IsAbs(name) || strings.ContainsAny(name, "\x00\r\n") {
		return "", fmt.Errorf("%w：路径必须为绝对路径", ErrInvalidLocalApp)
	}
	resolved, err := filepath.EvalSymlinks(name)
	if err != nil {
		return "", fmt.Errorf("%w：路径不存在或无法访问", ErrInvalidLocalApp)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("%w：无法读取路径", ErrInvalidLocalApp)
	}
	if directory {
		if !info.IsDir() {
			return "", fmt.Errorf("%w：工作目录必须为目录", ErrInvalidLocalApp)
		}
	} else {
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("%w：入口必须为普通文件", ErrInvalidLocalApp)
		}
		if runtime.GOOS == "windows" {
			if !strings.EqualFold(filepath.Ext(resolved), ".exe") {
				return "", fmt.Errorf("%w：Windows 入口必须为 EXE", ErrInvalidLocalApp)
			}
		} else if info.Mode().Perm()&0111 == 0 {
			return "", fmt.Errorf("%w：入口没有执行权限", ErrInvalidLocalApp)
		}
	}
	return resolved, nil
}

func (m *Manager) RegisterLocal(req LocalAppRequest) (*model.App, error) {
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 255 || strings.ContainsAny(req.Name+req.Args, "\x00\r\n") || len(req.Args) > 4096 {
		return nil, fmt.Errorf("%w：名称或参数无效", ErrInvalidLocalApp)
	}
	exe, err := canonicalLocalPath(req.ExePath, false)
	if err != nil {
		return nil, err
	}
	working := req.WorkingDir
	if working == "" {
		working = filepath.Dir(exe)
	}
	working, err = canonicalLocalPath(working, true)
	if err != nil {
		return nil, err
	}
	storage, err := filepath.Abs(m.config.Storage.AppsDir)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(storage, 0755); err != nil {
		return nil, err
	}
	storage, err = filepath.EvalSymlinks(storage)
	if err != nil {
		return nil, err
	}
	for _, reference := range []string{exe, working} {
		if rel, err := filepath.Rel(storage, reference); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return nil, fmt.Errorf("%w：本机程序及工作目录不能位于平台托管的应用数据目录内", ErrInvalidLocalApp)
		}
	}
	var template *string
	if req.ArgsTemplate != "" {
		args, ok := m.config.Templates[req.ArgsTemplate]
		if !ok {
			return nil, fmt.Errorf("%w：启动模板不存在", ErrInvalidLocalApp)
		}
		req.Args = args
		template = &req.ArgsTemplate
	}
	existing, err := m.store.GetAppByName(req.Name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, fmt.Errorf("%w：同名应用已存在", ErrInvalidLocalApp)
	}
	id := uuid.NewString()
	unlock, err := m.TryLock(id)
	if err != nil {
		return nil, err
	}
	defer unlock()
	owned := filepath.Join(storage, id)
	if err = os.Mkdir(owned, 0755); err != nil {
		return nil, err
	}
	record := &model.App{ID: id, Name: req.Name, Source: model.AppSourceLocal, Status: model.AppStatusDetecting, ExePath: exe, WorkingDir: working, AppDir: owned, Args: req.Args, ArgsTemplate: template, SunshineAppName: req.Name}
	if err = m.store.CreateApp(record); err != nil {
		_ = os.Remove(owned)
		return nil, err
	}
	m.store.CreateLog("app", id, "register_local", "success", "本机程序已登记，原程序文件由外部管理", nil)
	m.registerWithSunshine(id)
	return m.store.GetApp(id)
}

// ownedDirectory verifies the exact UUID child, not just a string prefix.
func (m *Manager) ownedDirectory(record *model.App) (string, error) {
	id, err := uuid.Parse(record.ID)
	if err != nil || id.String() != record.ID {
		return "", errors.New("应用数据目录所有权无效")
	}
	root, err := filepath.Abs(m.config.Storage.AppsDir)
	if err != nil {
		return "", err
	}
	if resolved, e := filepath.EvalSymlinks(root); e == nil {
		root = resolved
	}
	actual, err := filepath.Abs(record.AppDir)
	if err != nil {
		return "", err
	}
	expected := filepath.Join(root, record.ID)
	// Resolve the configured parent, but never follow a replacement application link.
	parent, err := filepath.EvalSymlinks(filepath.Dir(actual))
	if err == nil {
		actual = filepath.Join(parent, filepath.Base(actual))
	}
	same := actual == expected
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(actual, expected)
	}
	if !same {
		return "", errors.New("应用数据目录不属于当前平台存储目录")
	}
	if info, err := os.Lstat(actual); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("应用数据目录不能是链接或普通文件")
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return actual, nil
}

func programDirectory(record *model.App) string {
	if record.Source == model.AppSourceLocal {
		return filepath.Dir(record.ExePath)
	}
	return record.AppDir
}
func quoteProgram(exe string) string {
	// Sunshine expands $$ into a literal dollar before Boost parses the command.
	exe = strings.ReplaceAll(exe, "$", "$$")
	if runtime.GOOS != "windows" {
		exe = strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(exe)
	}
	return `"` + exe + `"`
}

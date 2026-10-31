package app

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Known non-entry executables to exclude
var excludedExeNames = map[string]bool{
	"crashreportclient.exe":                true,
	"ue4prereqsetup_x64.exe":               true,
	"unrealcefsubprocess.exe":              true,
	"crashreportclient-win64-shipping.exe": true,
}

// ExeCandidate represents a detected executable.
type ExeCandidate struct {
	RelativePath string `json:"relative_path"`
	FullPath     string `json:"full_path"`
	SizeBytes    int64  `json:"size_bytes"`
}

// DetectEntryExe scans the extracted directory for UE5 entry executables.
// Returns all candidates, excluding known non-entry files.
func DetectEntryExe(appDir string) ([]ExeCandidate, error) {
	return detectEntryPrograms(appDir, runtime.GOOS)
}

func detectEntryPrograms(appDir, platform string) ([]ExeCandidate, error) {
	var candidates []ExeCandidate
	root, err := os.OpenRoot(appDir)
	if err != nil {
		return nil, fmt.Errorf("读取应用目录失败: %w", err)
	}
	defer root.Close()
	err = filepath.WalkDir(appDir, func(full string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if full == appDir {
			return nil
		}
		if entry.IsDir() {
			if strings.EqualFold(entry.Name(), "Engine") || (platform == "windows" && filepath.Dir(full) != appDir) {
				return filepath.SkipDir
			}
			return nil
		}
		name := strings.ToLower(entry.Name())
		if !entry.Type().IsRegular() || excludedExeNames[name] || excludedExeNames[name+".exe"] || (platform == "windows" && !isExeCandidate(name)) || (platform == "linux" && (strings.HasSuffix(name, ".so") || strings.Contains(name, ".so."))) {
			return nil
		}
		relative, err := filepath.Rel(appDir, full)
		if err != nil {
			return err
		}
		file, err := root.Open(relative)
		if err != nil {
			return err
		}
		defer file.Close()
		if err := inspectProgram(file, platform); err != nil {
			return nil
		}
		info, err := file.Stat()
		if err != nil {
			return err
		}
		candidates = append(candidates, ExeCandidate{RelativePath: relative, FullPath: full, SizeBytes: info.Size()})
		return nil
	})
	return candidates, err
}

func isExeCandidate(name string) bool {
	if !strings.HasSuffix(strings.ToLower(name), ".exe") {
		return false
	}
	if excludedExeNames[strings.ToLower(name)] {
		return false
	}
	return true
}

// ValidatePEHeader checks if a file has a valid PE MZ header.
func ValidatePEHeader(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("无法打开文件: %w", err)
	}
	defer f.Close()

	header := make([]byte, 2)
	if _, err := f.Read(header); err != nil {
		return fmt.Errorf("无法读取文件头: %w", err)
	}

	if header[0] != 0x4D || header[1] != 0x5A { // MZ
		return fmt.Errorf("不是有效的 PE 可执行文件（缺少 MZ 头）")
	}

	return nil
}

// ValidateExePath validates a native entry confined to an extracted directory.
func ValidateExePath(appDir, exeRelPath string) error {
	_, _, err := resolveUploadedProgram(appDir, exeRelPath, false)
	return err
}

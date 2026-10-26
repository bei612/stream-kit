package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Known non-entry executables to exclude
var excludedExeNames = map[string]bool{
	"crashreportclient.exe":     true,
	"ue4prereqsetup_x64.exe":   true,
	"unrealcefsubprocess.exe":   true,
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
	var candidates []ExeCandidate

	// Scan root and one level of subdirectories
	entries, err := os.ReadDir(appDir)
	if err != nil {
		return nil, fmt.Errorf("读取应用目录失败: %w", err)
	}

	// Check root level
	for _, entry := range entries {
		if !entry.IsDir() && isExeCandidate(entry.Name()) {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			candidates = append(candidates, ExeCandidate{
				RelativePath: entry.Name(),
				FullPath:     filepath.Join(appDir, entry.Name()),
				SizeBytes:    info.Size(),
			})
		}
	}

	// Check one level of subdirectories (skip Engine/)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dirName := strings.ToLower(entry.Name())
		if dirName == "engine" {
			continue // Skip Engine/ directory entirely
		}

		subEntries, err := os.ReadDir(filepath.Join(appDir, entry.Name()))
		if err != nil {
			continue
		}
		for _, subEntry := range subEntries {
			if !subEntry.IsDir() && isExeCandidate(subEntry.Name()) {
				relPath := filepath.Join(entry.Name(), subEntry.Name())
				info, err := subEntry.Info()
				if err != nil {
					continue
				}
				candidates = append(candidates, ExeCandidate{
					RelativePath: relPath,
					FullPath:     filepath.Join(appDir, relPath),
					SizeBytes:    info.Size(),
				})
			}
		}
	}

	return candidates, nil
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

// ValidateExePath checks if the specified exe path exists and is a valid PE.
func ValidateExePath(appDir, exeRelPath string) error {
	fullPath := filepath.Join(appDir, exeRelPath)
	info, err := os.Stat(fullPath)
	if err != nil {
		return fmt.Errorf("文件不存在: %s", exeRelPath)
	}
	if info.IsDir() {
		return fmt.Errorf("路径指向目录，不是文件: %s", exeRelPath)
	}
	if !strings.HasSuffix(strings.ToLower(exeRelPath), ".exe") {
		return fmt.Errorf("文件不是 .exe: %s", exeRelPath)
	}
	return ValidatePEHeader(fullPath)
}

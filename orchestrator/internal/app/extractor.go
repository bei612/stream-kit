package app

import (
	"fmt"
	"path/filepath"
	"strings"
)

// NTFS reserved names (case-insensitive)
var ntfsReserved = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
	"com¹": true, "com²": true, "com³": true,
	"lpt¹": true, "lpt²": true, "lpt³": true,
}

type ExtractProgress struct {
	FilesExtracted int
	FilesTotal     int
	BytesWritten   int64
}

type ExtractConfig struct {
	MaxExtractSize int64
	MaxFileCount   int
	ProgressFn     func(ExtractProgress)
}

const maxPathLen = 240 // margin below Windows MAX_PATH (260)

func checkPathLength(target, name string) error {
	if len(target) > maxPathLen {
		return fmt.Errorf("路径过长（%d 字符，上限 %d）: %s", len(target), maxPathLen, name)
	}
	return nil
}

func validateEntryName(name string) error {
	name = strings.ReplaceAll(name, `\`, "/")
	// Archive entry names use slash separators even on Windows, where
	// filepath.IsAbs("/file") is false because no volume is specified.
	if name == "" || filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return fmt.Errorf("绝对路径: %s", name)
	}

	// NTFS ADS (alternate data stream)
	if strings.Contains(name, ":") {
		return fmt.Errorf("NTFS ADS: %s", name)
	}

	// Validate every component consistently on Windows and Linux.
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.TrimRight(part, " .") != part {
			return fmt.Errorf("无效路径段: %s", name)
		}
		for _, r := range part {
			if r < 32 || strings.ContainsRune(`<>"|?*`, r) {
				return fmt.Errorf("路径含非法字符: %s", name)
			}
		}
		base := strings.ToLower(strings.SplitN(part, ".", 2)[0])
		if ntfsReserved[base] || base == "conin$" || base == "conout$" {
			return fmt.Errorf("NTFS 保留名: %s", name)
		}
	}

	return nil
}

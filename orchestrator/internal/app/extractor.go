package app

import (
	"archive/tar"
	"archive/zip"
	"compress/bzip2"
	"compress/gzip"
	"fmt"
	"io"
	"os"
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

// Extract extracts an archive to destDir. Supports zip, tar, tar.gz, tar.bz2.
func Extract(archivePath, destDir string, cfg ExtractConfig) (int64, error) {
	ext := strings.ToLower(archivePath)

	switch {
	case strings.HasSuffix(ext, ".zip"):
		return extractZip(archivePath, destDir, cfg)
	case strings.HasSuffix(ext, ".tar.gz") || strings.HasSuffix(ext, ".tgz"):
		return extractTar(archivePath, destDir, cfg, "gz")
	case strings.HasSuffix(ext, ".tar.bz2"):
		return extractTar(archivePath, destDir, cfg, "bz2")
	case strings.HasSuffix(ext, ".tar"):
		return extractTar(archivePath, destDir, cfg, "")
	case strings.HasSuffix(ext, ".7z"):
		return 0, fmt.Errorf("7z 格式暂不支持（将在后续版本添加）")
	default:
		return 0, fmt.Errorf("不支持的压缩格式: %s", filepath.Ext(archivePath))
	}
}

func extractZip(archivePath, destDir string, cfg ExtractConfig) (int64, error) {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return 0, fmt.Errorf("打开 zip 文件失败: %w", err)
	}
	defer r.Close()

	var totalBytes int64
	fileCount := 0
	totalFiles := len(r.File)

	for _, f := range r.File {
		name := f.Name

		// Security checks
		if err := validateEntryName(name); err != nil {
			continue // skip bad entries
		}

		// Skip symlinks
		if f.FileInfo().Mode()&os.ModeSymlink != 0 {
			continue
		}

		target := filepath.Join(destDir, filepath.FromSlash(name))

		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) && filepath.Clean(target) != filepath.Clean(destDir) {
			continue
		}

		if err := checkPathLength(target, name); err != nil {
			return totalBytes, err
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0755)
			continue
		}

		// File count limit
		fileCount++
		if cfg.MaxFileCount > 0 && fileCount > cfg.MaxFileCount {
			return totalBytes, fmt.Errorf("文件数量超限（最大 %d）", cfg.MaxFileCount)
		}

		// Create parent directory
		os.MkdirAll(filepath.Dir(target), 0755)

		// Extract file
		written, err := extractZipEntry(f, target)
		if err != nil {
			return totalBytes, fmt.Errorf("解压文件 %s 失败: %w", name, err)
		}
		totalBytes += written

		// Size limit
		if cfg.MaxExtractSize > 0 && totalBytes > cfg.MaxExtractSize {
			return totalBytes, fmt.Errorf("解压后总大小超限（最大 %d 字节）", cfg.MaxExtractSize)
		}

		// Progress callback
		if cfg.ProgressFn != nil {
			cfg.ProgressFn(ExtractProgress{
				FilesExtracted: fileCount,
				FilesTotal:     totalFiles,
				BytesWritten:   totalBytes,
			})
		}
	}

	return totalBytes, nil
}

func extractZipEntry(f *zip.File, target string) (int64, error) {
	rc, err := f.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()

	out, err := os.Create(target)
	if err != nil {
		return 0, err
	}
	defer out.Close()

	return io.Copy(out, rc)
}

func extractTar(archivePath, destDir string, cfg ExtractConfig, compression string) (int64, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return 0, fmt.Errorf("打开文件失败: %w", err)
	}
	defer f.Close()

	var reader io.Reader = f
	switch compression {
	case "gz":
		gr, err := gzip.NewReader(f)
		if err != nil {
			return 0, fmt.Errorf("gzip 解码失败: %w", err)
		}
		defer gr.Close()
		reader = gr
	case "bz2":
		reader = bzip2.NewReader(f)
	}

	tr := tar.NewReader(reader)
	var totalBytes int64
	fileCount := 0

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return totalBytes, fmt.Errorf("读取 tar 条目失败: %w", err)
		}

		name := header.Name
		if err := validateEntryName(name); err != nil {
			continue
		}

		target := filepath.Join(destDir, filepath.FromSlash(name))
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) && filepath.Clean(target) != filepath.Clean(destDir) {
			continue
		}

		if err := checkPathLength(target, name); err != nil {
			return totalBytes, err
		}

		switch header.Typeflag {
		case tar.TypeDir:
			os.MkdirAll(target, 0755)
		case tar.TypeReg:
			fileCount++
			if cfg.MaxFileCount > 0 && fileCount > cfg.MaxFileCount {
				return totalBytes, fmt.Errorf("文件数量超限（最大 %d）", cfg.MaxFileCount)
			}

			os.MkdirAll(filepath.Dir(target), 0755)
			out, err := os.Create(target)
			if err != nil {
				return totalBytes, err
			}
			written, err := io.Copy(out, tr)
			out.Close()
			if err != nil {
				return totalBytes, err
			}
			totalBytes += written

			if cfg.MaxExtractSize > 0 && totalBytes > cfg.MaxExtractSize {
				return totalBytes, fmt.Errorf("解压后总大小超限（最大 %d 字节）", cfg.MaxExtractSize)
			}

			if cfg.ProgressFn != nil {
				cfg.ProgressFn(ExtractProgress{
					FilesExtracted: fileCount,
					BytesWritten:   totalBytes,
				})
			}
		default:
			// Skip symlinks, etc.
			continue
		}
	}

	return totalBytes, nil
}

const maxPathLen = 240 // margin below Windows MAX_PATH (260)

func checkPathLength(target, name string) error {
	if len(target) > maxPathLen {
		return fmt.Errorf("路径过长（%d 字符，上限 %d）: %s", len(target), maxPathLen, name)
	}
	return nil
}

func validateEntryName(name string) error {
	// Path traversal
	if strings.Contains(name, "..") {
		return fmt.Errorf("路径穿越: %s", name)
	}
	if filepath.IsAbs(name) {
		return fmt.Errorf("绝对路径: %s", name)
	}

	// NTFS ADS (alternate data stream)
	if strings.Contains(name, ":") {
		return fmt.Errorf("NTFS ADS: %s", name)
	}

	// NTFS reserved names
	base := strings.ToLower(filepath.Base(name))
	// Remove extension for checking
	if idx := strings.IndexByte(base, '.'); idx >= 0 {
		base = base[:idx]
	}
	if ntfsReserved[base] {
		return fmt.Errorf("NTFS 保留名: %s", name)
	}

	return nil
}

package app

import (
	"archive/tar"
	"archive/zip"
	"compress/bzip2"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"hash"
	"hash/crc32"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/bodgit/sevenzip"
	"github.com/klauspost/compress/zstd"
	"github.com/nwaples/rardecode/v2"
	"github.com/ulikunitz/xz"
)

var archiveExtensions = []string{".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".zip", ".7z", ".rar", ".tar", ".tgz", ".tbz2", ".txz", ".tzst"}

// ArchiveExtension preserves the complete recognized suffix in temporary uploads.
func ArchiveExtension(name string) string {
	for _, ext := range archiveExtensions {
		if strings.HasSuffix(strings.ToLower(name), ext) {
			return ext
		}
	}
	return ""
}
func SupportedArchiveExtensions() []string { return append([]string(nil), archiveExtensions...) }

// Extract confines every format to an empty upload-owned directory.
func Extract(archivePath, destDir string, cfg ExtractConfig) (int64, error) {
	return ExtractContext(context.Background(), archivePath, destDir, cfg)
}

func ExtractContext(ctx context.Context, archivePath, destDir string, cfg ExtractConfig) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if cfg.MaxExtractSize <= 0 || cfg.MaxFileCount <= 0 {
		return 0, errors.New("解压大小和文件数量限制必须大于零")
	}
	ext := ArchiveExtension(archivePath)
	if ext == "" {
		return 0, fmt.Errorf("不支持的压缩格式: %s", filepath.Ext(archivePath))
	}
	info, err := os.Lstat(destDir)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("解压目标必须为真实目录")
	}
	root, err := os.OpenRoot(destDir)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return 0, err
	}
	_, err = dir.Readdirnames(1)
	dir.Close()
	if err != io.EOF {
		return 0, errors.New("解压目标必须为空目录")
	}
	sink := &extractSink{root: root, destination: destDir, cfg: cfg, names: make(map[string]string), ctx: ctx}
	file, err := os.Open(archivePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return 0, err
	}
	source := &contextArchiveSource{ctx: ctx, file: file}
	switch ext {
	case ".zip":
		reader, e := zip.NewReader(source, stat.Size())
		if e != nil {
			return 0, e
		}
		for _, entry := range reader.File {
			if e = sink.entry(entry.Name, entry.Mode(), entry.UncompressedSize64, entry.Open); e != nil {
				return sink.bytes, e
			}
		}
	case ".7z":
		// ReaderAt reads only this upload, never adjacent multipart files.
		reader, e := sevenzip.NewReader(source, stat.Size())
		if e != nil {
			return 0, e
		}
		for _, entry := range reader.File {
			open := func() (io.ReadCloser, error) {
				r, err := entry.Open()
				if err != nil {
					return nil, err
				}
				return &archiveChecksumReader{ReadCloser: r, hash: crc32.NewIEEE(), expected: entry.CRC32}, nil
			}
			if e = sink.entry(entry.Name, entry.Mode(), entry.UncompressedSize, open); e != nil {
				return sink.bytes, e
			}
		}
	case ".rar":
		reader, e := rardecode.NewReader(source, rardecode.MaxDictionarySize(128<<20))
		if e != nil {
			return 0, e
		}
		for {
			if err := ctx.Err(); err != nil {
				return sink.bytes, err
			}
			header, e := reader.Next()
			if e == io.EOF {
				break
			}
			if e != nil {
				return sink.bytes, e
			}
			if header.Encrypted || header.HeaderEncrypted || header.LinkType != 0 || header.LinkTarget != "" {
				return sink.bytes, errors.New("不支持加密或链接条目")
			}
			if header.UnKnownSize || header.UnPackedSize < 0 {
				return sink.bytes, errors.New("压缩条目缺少有效长度")
			}
			if e = sink.entry(header.Name, header.Mode(), uint64(header.UnPackedSize), func() (io.ReadCloser, error) { return io.NopCloser(reader), nil }); e != nil {
				return sink.bytes, e
			}
		}
	default:
		var reader io.Reader = source
		switch ext {
		case ".tar.gz", ".tgz":
			gz, e := gzip.NewReader(source)
			if e != nil {
				return 0, e
			}
			defer gz.Close()
			reader = gz
		case ".tar.bz2", ".tbz2":
			reader = bzip2.NewReader(source)
		case ".tar.xz", ".txz":
			reader, err = (xz.ReaderConfig{DictCap: 128 << 20}).NewReader(source)
			if err != nil {
				return 0, err
			}
		case ".tar.zst", ".tzst":
			z, e := zstd.NewReader(source, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(128<<20))
			if e != nil {
				return 0, e
			}
			defer z.Close()
			reader = z
		}
		// TAR Next consumes PAX/GNU metadata internally. Bound the complete
		// decompressed stream, not only file payloads that reach the sink.
		reader = &contextArchiveReader{ctx: ctx, reader: &archiveBudgetReader{reader: reader, remaining: tarDecodeBudget(cfg)}}
		tr := tar.NewReader(reader)
		for {
			header, e := tr.Next()
			if e == io.EOF {
				break
			}
			if e != nil {
				return sink.bytes, e
			}
			if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
				return sink.bytes, fmt.Errorf("不支持的压缩条目类型: %s", header.Name)
			}
			if header.Size < 0 {
				return sink.bytes, errors.New("压缩条目长度无效")
			}
			if e = sink.entry(header.Name, header.FileInfo().Mode(), uint64(header.Size), func() (io.ReadCloser, error) { return io.NopCloser(tr), nil }); e != nil {
				return sink.bytes, e
			}
		}
		// Verify the compression footer; bound legal zero padding after TAR EOF.
		trailer := make([]byte, 32<<10)
		remaining := int64(1 << 20)
		for {
			n, e := reader.Read(trailer)
			remaining -= int64(n)
			if remaining < 0 {
				return sink.bytes, errors.New("tar 尾部填充超限")
			}
			for _, b := range trailer[:n] {
				if b != 0 {
					return sink.bytes, errors.New("tar 尾部包含非填充数据")
				}
			}
			if e == io.EOF {
				break
			}
			if e != nil {
				return sink.bytes, e
			}
		}
	}
	return sink.bytes, ctx.Err()
}

type contextArchiveReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextArchiveReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

type contextArchiveSource struct {
	ctx  context.Context
	file *os.File
}

func (r *contextArchiveSource) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.file.Read(p)
}
func (r *contextArchiveSource) ReadAt(p []byte, offset int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.file.ReadAt(p, offset)
}

type archiveChecksumReader struct {
	io.ReadCloser
	hash     hash.Hash32
	expected uint32
}

var errArchiveDecodeBudget = errors.New("压缩包解码数据总量超限")

// Allow file payloads, one header/padding block pair per entry, and a shared
// metadata/footer allowance. Saturation prevents configured limits overflowing.
func tarDecodeBudget(cfg ExtractConfig) int64 {
	const metadataAllowance int64 = 16 << 20
	budget := cfg.MaxExtractSize
	if budget > math.MaxInt64-metadataAllowance {
		return math.MaxInt64
	}
	budget += metadataAllowance
	if int64(cfg.MaxFileCount) > (math.MaxInt64-budget)/1024 {
		return math.MaxInt64
	}
	return budget + int64(cfg.MaxFileCount)*1024
}

type archiveBudgetReader struct {
	reader    io.Reader
	remaining int64
}

func (r *archiveBudgetReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if r.remaining == 0 {
		// Distinguish exact-boundary EOF from additional decoded data.
		var probe [1]byte
		n, err := r.reader.Read(probe[:])
		if n != 0 {
			return 0, errArchiveDecodeBudget
		}
		return 0, err
	}
	if int64(len(p)) > r.remaining {
		p = p[:int(r.remaining)]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	return n, err
}

func (r *archiveChecksumReader) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	_, _ = r.hash.Write(p[:n])
	if err == io.EOF && r.expected != 0 && r.hash.Sum32() != r.expected {
		err = errors.New("7z 文件校验和不匹配")
	}
	return n, err
}

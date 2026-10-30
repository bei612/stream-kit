package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// All decoders share path, type, overwrite and budget enforcement.
type extractSink struct {
	root         *os.Root
	destination  string
	cfg          ExtractConfig
	names        map[string]string
	count, files int
	bytes        int64
	entries      int
	ctx          context.Context
}

func (s *extractSink) directory(name string) error {
	if name == "." {
		return nil
	}
	if err := s.directory(path.Dir(name)); err != nil {
		return err
	}
	key := strings.ToLower(name)
	if existing, ok := s.names[key]; ok {
		if existing != name+"/" {
			return fmt.Errorf("条目路径冲突: %s", name)
		}
		return nil
	}
	if s.count >= s.cfg.MaxFileCount {
		return errors.New("压缩包条目数量超限")
	}
	if err := s.root.Mkdir(filepath.FromSlash(name), 0755); err != nil {
		return err
	}
	s.names[key] = name + "/"
	s.count++
	return nil
}
func (s *extractSink) entry(raw string, mode os.FileMode, size uint64, open func() (io.ReadCloser, error)) error {
	if s.ctx != nil {
		if err := s.ctx.Err(); err != nil {
			return err
		}
	}
	// Count decoded entries even when a root or repeated directory creates no inode.
	if s.entries >= s.cfg.MaxFileCount {
		return errors.New("压缩包条目数量超限")
	}
	s.entries++
	name := strings.TrimSuffix(strings.ReplaceAll(raw, `\`, "/"), "/")
	for strings.HasPrefix(name, "./") {
		name = strings.TrimPrefix(name, "./")
	}
	if name == "." && mode.IsDir() {
		return nil
	}
	if err := validateEntryName(name); err != nil {
		return err
	}
	if err := checkPathLength(filepath.Join(s.destination, filepath.FromSlash(name)), name); err != nil {
		return err
	}
	if mode.IsDir() {
		return s.directory(name)
	}
	if !mode.IsRegular() {
		return fmt.Errorf("不支持链接或特殊文件: %s", name)
	}
	if size > uint64(s.cfg.MaxExtractSize-s.bytes) {
		return errors.New("解压后总大小超限")
	}
	if err := s.directory(path.Dir(name)); err != nil {
		return err
	}
	key := strings.ToLower(name)
	if _, ok := s.names[key]; ok {
		return fmt.Errorf("重复或大小写冲突的条目: %s", name)
	}
	if s.count >= s.cfg.MaxFileCount {
		return errors.New("压缩包条目数量超限")
	}
	input, err := open()
	if err != nil {
		return err
	}
	// Preserve executable bits for Linux, never privileged permissions.
	output, err := s.root.OpenFile(filepath.FromSlash(name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644|(mode.Perm()&0111))
	if err != nil {
		input.Close()
		return err
	}
	// Reject overproducing decoders at this entry's declared boundary, rather
	// than allowing a malformed small entry to consume the entire archive quota.
	// The declared size has already been checked against the remaining quota.
	budget := &extractWriter{out: output, remaining: int64(size)}
	var source io.Reader = input
	if s.ctx != nil {
		source = &contextArchiveReader{ctx: s.ctx, reader: input}
	}
	written, copyErr := io.Copy(budget, source)
	err = errors.Join(copyErr, input.Close(), output.Close())
	if s.ctx != nil {
		err = errors.Join(err, s.ctx.Err())
	}
	s.bytes += written
	if err == nil && uint64(written) != size {
		err = errors.New("压缩条目实际长度与声明不符")
	}
	if err != nil {
		_ = s.root.Remove(filepath.FromSlash(name))
		return fmt.Errorf("解压 %s 失败: %w", name, err)
	}
	s.names[key] = name
	s.count++
	s.files++
	if s.cfg.ProgressFn != nil {
		s.cfg.ProgressFn(ExtractProgress{FilesExtracted: s.files, BytesWritten: s.bytes})
	}
	return nil
}

type extractWriter struct {
	out       io.Writer
	remaining int64
}

func (w *extractWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errors.New("解压后总大小超限")
	}
	n, err := w.out.Write(p)
	w.remaining -= int64(n)
	return n, err
}

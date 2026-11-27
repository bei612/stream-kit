package app

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"
)

func TestZIPEntryLimitRejectsBeforeExtracting(t *testing.T) {
	archive := zipFixture(t, "first.bin", "second.bin")
	dest, written, err := extractFixture(t, ".zip", archive, ExtractConfig{MaxExtractSize: 100, MaxFileCount: 1})
	if !errors.Is(err, errArchiveEntryCount) || written != 0 {
		t.Fatalf("ZIP entry limit: wrote %d bytes, error %v", written, err)
	}
	if files, err := os.ReadDir(dest); err != nil || len(files) != 0 {
		t.Fatalf("ZIP entry limit left files: %v (%v)", files, err)
	}
}

func TestZIP64DirectoryEntryLimitAndCompatibility(t *testing.T) {
	const files = 65536
	var data bytes.Buffer
	w := zip.NewWriter(&data)
	if err := w.SetComment("archive footer comment"); err != nil {
		t.Fatal(err)
	}
	for i := range files {
		if _, err := w.CreateHeader(&zip.FileHeader{Name: fmt.Sprintf("file-%05d", i), Method: zip.Store}); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	source := bytes.NewReader(data.Bytes())
	if _, err := openArchiveZIP(source, source.Size(), files-1); !errors.Is(err, errArchiveEntryCount) {
		t.Fatalf("ZIP64 entry limit: %v", err)
	}
	accepted, err := openArchiveZIP(source, source.Size(), files)
	if err != nil || len(accepted.File) != files {
		t.Fatalf("valid ZIP64 at configured limit: %v", err)
	}
}

func TestZIPDirectoryAllowsUnambiguousPrefix(t *testing.T) {
	archive := append([]byte("prefix from packaging"), zipFixture(t, "program.bin")...)
	if _, written, err := extractFixture(t, ".zip", archive, ExtractConfig{MaxExtractSize: 100, MaxFileCount: 1}); err != nil || written != 7 {
		t.Fatalf("prefixed ZIP: wrote %d bytes, error %v", written, err)
	}
}

func TestZIP64AcceptsDirectoryBeyond25GiB(t *testing.T) {
	const offset = 26 << 30
	var data bytes.Buffer
	w := zip.NewWriter(&data)
	w.SetOffset(offset)
	entry, err := w.CreateHeader(&zip.FileHeader{Name: "program.bin", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(entry, "payload"); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	source := paddedZIPSource{offset: offset, archive: bytes.NewReader(data.Bytes())}
	archive, err := openArchiveZIP(source, offset+int64(data.Len()), 1)
	if err != nil {
		t.Fatal(err)
	}
	file, err := archive.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if contents, err := io.ReadAll(file); err != nil || string(contents) != "payload" {
		t.Fatalf("ZIP64 payload: %q, %v", contents, err)
	}
}

// Represent padding before a ZIP without allocating or filling a large disk file.
type paddedZIPSource struct {
	offset  int64
	archive *bytes.Reader
}

func (s paddedZIPSource) ReadAt(dst []byte, offset int64) (int, error) {
	if offset >= s.offset {
		return s.archive.ReadAt(dst, offset-s.offset)
	}
	padding := int(min(int64(len(dst)), s.offset-offset))
	clear(dst[:padding])
	if padding == len(dst) {
		return padding, nil
	}
	n, err := s.archive.ReadAt(dst[padding:], 0)
	return padding + n, err
}

package app

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
	"github.com/ulikunitz/xz"
)

func tarFixture(t *testing.T, name string, kind byte, data []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	size := int64(len(data))
	if kind != tar.TypeReg {
		size = 0
	}
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0755, Typeflag: kind, Size: size, Linkname: "../outside"}); err != nil {
		t.Fatal(err)
	}
	if size > 0 {
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func zipFixture(t *testing.T, names ...string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range names {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte("payload")); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// A minimal stored RAR 4 archive, built from the public RAR header format.
func rarFixture() []byte {
	var archive bytes.Buffer
	archive.Write([]byte{'R', 'a', 'r', '!', 0x1a, 7, 0})
	header := func(kind byte, flags uint16, body []byte) {
		var b bytes.Buffer
		b.WriteByte(kind)
		_ = binary.Write(&b, binary.LittleEndian, flags)
		_ = binary.Write(&b, binary.LittleEndian, uint16(7+len(body)))
		b.Write(body)
		_ = binary.Write(&archive, binary.LittleEndian, uint16(crc32.ChecksumIEEE(b.Bytes())))
		archive.Write(b.Bytes())
	}
	header(0x73, 0, make([]byte, 6))
	data := []byte("payload")
	name := []byte("game.bin")
	var file bytes.Buffer
	_ = binary.Write(&file, binary.LittleEndian, uint32(len(data)))
	_ = binary.Write(&file, binary.LittleEndian, uint32(len(data)))
	file.WriteByte(3)
	_ = binary.Write(&file, binary.LittleEndian, crc32.ChecksumIEEE(data))
	_ = binary.Write(&file, binary.LittleEndian, uint32(0))
	file.WriteByte(20)
	file.WriteByte(0x30)
	_ = binary.Write(&file, binary.LittleEndian, uint16(len(name)))
	_ = binary.Write(&file, binary.LittleEndian, uint32(0100755))
	file.Write(name)
	header(0x74, 0x8000, file.Bytes())
	archive.Write(data)
	header(0x7b, 0, nil)
	return archive.Bytes()
}
func extractFixture(t *testing.T, ext string, data []byte, cfg ExtractConfig) (string, int64, error) {
	t.Helper()
	base := t.TempDir()
	source := filepath.Join(base, "upload"+ext)
	destination := filepath.Join(base, "app")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	size, err := Extract(source, destination, cfg)
	return destination, size, err
}
func TestArchiveFormatsAndContents(t *testing.T) {
	source := tarFixture(t, "game.bin", tar.TypeReg, []byte("payload"))
	cases := map[string][]byte{".tar": source, ".zip": zipFixture(t, "game.bin"), ".rar": rarFixture()}
	bz2, err := os.ReadFile(filepath.Join("testdata", "application.tar.bz2"))
	if err != nil {
		t.Fatal(err)
	}
	cases[".tar.bz2"] = bz2
	for _, extension := range []string{".tar.gz", ".tar.xz", ".tar.zst"} {
		var buffer bytes.Buffer
		var writer io.WriteCloser
		var err error
		switch extension {
		case ".tar.gz":
			writer = gzip.NewWriter(&buffer)
		case ".tar.xz":
			writer, err = xz.NewWriter(&buffer)
		case ".tar.zst":
			writer, err = zstd.NewWriter(&buffer)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Write(source); err != nil {
			t.Fatal(err)
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		cases[extension] = buffer.Bytes()
	}
	for alias, original := range map[string]string{".tgz": ".tar.gz", ".tbz2": ".tar.bz2", ".txz": ".tar.xz", ".tzst": ".tar.zst"} {
		cases[alias] = cases[original]
	}
	for ext, data := range cases {
		t.Run(ext, func(t *testing.T) {
			destination, size, err := extractFixture(t, ext, data, ExtractConfig{MaxExtractSize: 100, MaxFileCount: 10})
			if err != nil {
				t.Fatal(err)
			}
			if size != 7 {
				t.Fatal(size)
			}
			got, err := os.ReadFile(filepath.Join(destination, "game.bin"))
			if err != nil || string(got) != "payload" {
				t.Fatalf("payload: %q %v", got, err)
			}
		})
	}
}
func TestArchiveRejectsTraversalLinksOverwriteAndLimits(t *testing.T) {
	cases := []struct {
		name, ext string
		data      []byte
		size      int64
		count     int
	}{
		{"zip traversal", ".zip", zipFixture(t, "../escape"), 100, 10},
		{"directory reserved name", ".zip", zipFixture(t, "NUL/game.bin"), 100, 10},
		{"duplicate", ".zip", zipFixture(t, "game.bin", "game.bin"), 100, 10},
		{"case collision", ".zip", zipFixture(t, "Game.bin", "game.bin"), 100, 10},
		{"directory case collision", ".zip", zipFixture(t, "Bin/a", "bin/b"), 100, 10},
		{"size", ".zip", zipFixture(t, "game.bin"), 6, 10},
		{"entry count", ".zip", zipFixture(t, "a", "b"), 100, 1},
		{"implicit directories counted", ".zip", zipFixture(t, "a/b/c"), 100, 2},
		{"tar traversal", ".tar", tarFixture(t, "../escape", tar.TypeReg, []byte("payload")), 100, 10},
		{"tar symlink", ".tar", tarFixture(t, "link", tar.TypeSymlink, nil), 100, 10},
		{"tar hardlink", ".tar", tarFixture(t, "link", tar.TypeLink, nil), 100, 10},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			destination, size, err := extractFixture(t, test.ext, test.data, ExtractConfig{MaxExtractSize: test.size, MaxFileCount: test.count})
			if err == nil {
				t.Fatal("unsafe archive accepted")
			}
			if size > test.size {
				t.Fatal("wrote beyond budget")
			}
			if _, err := os.Stat(filepath.Join(destination, "..", "escape")); !os.IsNotExist(err) {
				t.Fatal("escaped destination")
			}
		})
	}
}
func TestArchiveWriterStopsBeforeBudgetAndDoesNotOverwriteExistingFiles(t *testing.T) {
	var buffer bytes.Buffer
	writer := extractWriter{out: &buffer, remaining: 3}
	if _, err := writer.Write([]byte("oversized")); err == nil || buffer.Len() != 0 {
		t.Fatal("budget enforced after writing")
	}
	base := t.TempDir()
	source := filepath.Join(base, "upload.zip")
	destination := filepath.Join(base, "app")
	_ = os.Mkdir(destination, 0700)
	_ = os.WriteFile(source, zipFixture(t, "game.bin"), 0600)
	_ = os.WriteFile(filepath.Join(destination, "existing"), []byte("keep"), 0600)
	if _, err := Extract(source, destination, ExtractConfig{MaxExtractSize: 100, MaxFileCount: 10}); err == nil {
		t.Fatal("accepted nonempty target")
	}
	data, _ := os.ReadFile(filepath.Join(destination, "existing"))
	if string(data) != "keep" {
		t.Fatal("modified existing data")
	}
	for _, ext := range SupportedArchiveExtensions() {
		if got := ArchiveExtension("App" + ext); got != ext {
			t.Fatalf("suffix %s became %s", ext, got)
		}
	}
	if ArchiveExtension("program.exe") != "" {
		t.Fatal("nonarchive allowed")
	}
}

func TestSevenZipPlainAndCompressedHeaders(t *testing.T) {
	for _, fixture := range []string{"plain-header.7z", "compressed-header.7z"} {
		t.Run(fixture, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", fixture))
			if err != nil {
				t.Fatal(err)
			}
			destination, size, err := extractFixture(t, ".7z", data, ExtractConfig{MaxExtractSize: 1 << 20, MaxFileCount: 100})
			if err != nil {
				t.Fatal(err)
			}
			entries, err := os.ReadDir(destination)
			if err != nil || len(entries) == 0 || size == 0 {
				t.Fatalf("empty extraction: %d %v", size, err)
			}
		})
	}
}

func TestTarCompressionChecksumIsValidated(t *testing.T) {
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	_, _ = gz.Write(tarFixture(t, "game.bin", tar.TypeReg, []byte("payload")))
	_ = gz.Close()
	data := buffer.Bytes()
	data[len(data)-8] ^= 0xff
	if _, _, err := extractFixture(t, ".tar.gz", data, ExtractConfig{MaxExtractSize: 100, MaxFileCount: 10}); err == nil {
		t.Fatal("accepted corrupt gzip footer")
	}
}

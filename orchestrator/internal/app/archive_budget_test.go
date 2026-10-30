package app

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
	"testing"
)

func TestArchiveCountsRepeatedDirectoryEntries(t *testing.T) {
	for _, name := range []string{"./", "folder/"} {
		for _, ext := range []string{".tar", ".zip"} {
			t.Run(ext+name, func(t *testing.T) {
				var data bytes.Buffer
				if ext == ".tar" {
					w := tar.NewWriter(&data)
					for range 3 {
						if err := w.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0755}); err != nil {
							t.Fatal(err)
						}
					}
					if err := w.Close(); err != nil {
						t.Fatal(err)
					}
				} else {
					w := zip.NewWriter(&data)
					for range 3 {
						if _, err := w.Create(name); err != nil {
							t.Fatal(err)
						}
					}
					if err := w.Close(); err != nil {
						t.Fatal(err)
					}
				}
				_, _, err := extractFixture(t, ext, data.Bytes(), ExtractConfig{MaxExtractSize: 100, MaxFileCount: 2})
				if err == nil || !strings.Contains(err.Error(), "条目数量超限") {
					t.Fatalf("repeated directories bypassed count: %v", err)
				}
			})
		}
	}
}

func TestTarBoundsHiddenExtendedHeaders(t *testing.T) {
	var seed bytes.Buffer
	w := tar.NewWriter(&seed)
	if err := w.WriteHeader(&tar.Header{Name: "game.bin", Mode: 0755, Size: 1, Format: tar.FormatPAX, PAXRecords: map[string]string{"comment": strings.Repeat("x", 512<<10)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	header := seed.Bytes()[:512]
	if header[156] != tar.TypeXHeader {
		t.Fatal("fixture did not contain hidden PAX header")
	}
	size, err := strconv.ParseInt(strings.Trim(string(header[124:136]), " \x00"), 8, 64)
	if err != nil {
		t.Fatal(err)
	}
	prefix := seed.Bytes()[:512+((size+511)/512)*512]
	data := bytes.Repeat(prefix, 34)
	data = append(data, tarFixture(t, "game.bin", tar.TypeReg, []byte("x"))...)
	// Prove the standard TAR parser hides all repeated metadata from the sink.
	reader := tar.NewReader(bytes.NewReader(data))
	if h, err := reader.Next(); err != nil || h.Name != "game.bin" {
		t.Fatalf("invalid fixture: %v %v", h, err)
	}
	for _, ext := range []string{".tar", ".tar.gz"} {
		t.Run(ext, func(t *testing.T) {
			input := data
			if ext == ".tar.gz" {
				var compressed bytes.Buffer
				gz := gzip.NewWriter(&compressed)
				if _, err := gz.Write(data); err != nil {
					t.Fatal(err)
				}
				if err := gz.Close(); err != nil {
					t.Fatal(err)
				}
				input = compressed.Bytes()
			}
			_, written, err := extractFixture(t, ext, input, ExtractConfig{MaxExtractSize: 1, MaxFileCount: 1})
			if !errors.Is(err, errArchiveDecodeBudget) || written != 0 {
				t.Fatalf("hidden metadata accepted: written=%d error=%v", written, err)
			}
		})
	}
}

func TestArchiveBudgetBoundaryAndOverflow(t *testing.T) {
	for _, n := range []int{2, 3, 4} {
		r := &archiveBudgetReader{reader: bytes.NewReader(bytes.Repeat([]byte{'x'}, n)), remaining: 3}
		data, err := io.ReadAll(r)
		if n <= 3 && (err != nil || len(data) != n) {
			t.Fatalf("valid boundary %d: %d %v", n, len(data), err)
		}
		if n > 3 && (!errors.Is(err, errArchiveDecodeBudget) || len(data) != 3) {
			t.Fatalf("overflow accepted: %d %v", len(data), err)
		}
	}
	if got := tarDecodeBudget(ExtractConfig{MaxExtractSize: math.MaxInt64, MaxFileCount: 1}); got != math.MaxInt64 {
		t.Fatalf("payload overflow: %d", got)
	}
	if got := tarDecodeBudget(ExtractConfig{MaxExtractSize: 1, MaxFileCount: math.MaxInt}); got != math.MaxInt64 {
		t.Fatalf("entry overhead overflow: %d", got)
	}
}

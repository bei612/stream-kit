package app

import (
	"io"
	"os"
	"testing"
)

type oversizedEntry struct {
	reads  int
	closed bool
}

func (r *oversizedEntry) Read(p []byte) (int, error) { r.reads++; clear(p); return len(p), nil }
func (r *oversizedEntry) Close() error               { r.closed = true; return nil }

func TestExtractionStopsOverproducingEntryBeforeArchiveQuota(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, size := range []uint64{0, 1, 65536} {
		input := &oversizedEntry{}
		sink := &extractSink{root: root, destination: dir, cfg: ExtractConfig{MaxExtractSize: 1 << 30, MaxFileCount: 10}, names: map[string]string{}}
		err := sink.entry("malformed.bin", 0644, size, func() (io.ReadCloser, error) { return input, nil })
		if err == nil || !input.closed {
			t.Fatalf("decoder accepted or leaked: %v", err)
		}
		if sink.bytes > int64(size) || input.reads > 4 {
			t.Fatalf("entry consumed archive budget: bytes=%d reads=%d", sink.bytes, input.reads)
		}
		if _, err := root.Stat("malformed.bin"); !os.IsNotExist(err) {
			t.Fatalf("partial entry retained: %v", err)
		}
	}
}

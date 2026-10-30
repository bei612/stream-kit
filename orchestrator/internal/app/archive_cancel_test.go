package app

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/model"
)

func TestExtractContextCanceledBeforeOpening(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ExtractContext(ctx, "missing.zip", "missing", ExtractConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestExtractContextStopsBetweenFiles(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	base := t.TempDir()
	source := filepath.Join(base, "upload.zip")
	dest := filepath.Join(base, "out")
	if err := os.WriteFile(source, zipFixture(t, "first.bin", "second.bin"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dest, 0700); err != nil {
		t.Fatal(err)
	}
	n, err := ExtractContext(ctx, source, dest, ExtractConfig{MaxExtractSize: 100, MaxFileCount: 10, ProgressFn: func(ExtractProgress) { cancel() }})
	if !errors.Is(err, context.Canceled) || n != 7 {
		t.Fatalf("cancel failed: %d %v", n, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "second.bin")); !os.IsNotExist(err) {
		t.Fatalf("continued writing: %v", err)
	}
}

type cancelEntryReader struct {
	cancel context.CancelFunc
	closed bool
	reads  int
}

func (r *cancelEntryReader) Read(p []byte) (int, error) {
	r.reads++
	r.cancel()
	copy(p, "data")
	return 4, nil
}
func (r *cancelEntryReader) Close() error { r.closed = true; return nil }

func TestExtractContextRemovesCanceledPartialEntry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	sink := &extractSink{root: root, destination: dir, ctx: ctx, cfg: ExtractConfig{MaxExtractSize: 100, MaxFileCount: 10}, names: map[string]string{}}
	input := &cancelEntryReader{cancel: cancel}
	err = sink.entry("partial.bin", 0644, 8, func() (io.ReadCloser, error) { return input, nil })
	if !errors.Is(err, context.Canceled) || !input.closed || input.reads != 1 {
		t.Fatalf("partial cancel: reads=%d closed=%v error=%v", input.reads, input.closed, err)
	}
	if _, err := root.Stat("partial.bin"); !os.IsNotExist(err) {
		t.Fatalf("partial retained: %v", err)
	}
}

func TestUploadShutdownDrainsAndRejectsLateCompletion(t *testing.T) {
	for _, late := range []bool{false, true} {
		t.Run(map[bool]string{false: "accepted-before-shutdown", true: "completed-after-shutdown"}[late], func(t *testing.T) {
			m, st, _ := localFixture(t)
			m.config.Storage.TempDir = t.TempDir()
			m.config.Storage.MaxExtractSize = 1024
			m.config.Storage.MaxFileCount = 10
			app, err := m.CreateApp("cancel-upload", "", "", "", 10, model.CaptureDesktop)
			if err != nil {
				t.Fatal(err)
			}
			release, err := m.TryLockUpload()
			if err != nil {
				t.Fatal(err)
			}
			archive, err := m.CreateUploadArchive("program.zip")
			if err != nil {
				release()
				t.Fatal(err)
			}
			if _, err := archive.File.Write(zipFixture(t, "game.exe")); err != nil {
				t.Fatal(err)
			}
			if err := archive.File.Close(); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			var shutdown chan error
			if late {
				shutdown = make(chan error, 1)
				go func() { shutdown <- m.Shutdown(ctx) }()
				<-m.workCtx.Done()
				select {
				case err := <-shutdown:
					t.Fatalf("shutdown did not wait for admitted upload: %v", err)
				default:
				}
			} else {
				m.cancelWork()
			}
			m.ProcessUploadComplete(app.ID, archive, release)
			if late {
				if err := <-shutdown; err != nil {
					t.Fatal(err)
				}
			}
			if err := m.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			if err := m.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			if m.IsUploading() {
				t.Fatal("upload lock leaked")
			}
			if release, err := m.TryLockUpload(); err == nil {
				release()
				t.Fatal("shutdown accepted new upload")
			}
			if rows, err := st.ListUploadArchives(); err != nil || len(rows) != 0 {
				t.Fatalf("staging journal retained: %v %v", rows, err)
			}
			if _, err := os.Stat(archive.Path); !os.IsNotExist(err) {
				t.Fatalf("archive retained: %v", err)
			}
			saved, err := st.GetApp(app.ID)
			if err != nil || saved.Status != model.AppStatusError {
				t.Fatalf("cancel state: %+v %v", saved, err)
			}
		})
	}
}

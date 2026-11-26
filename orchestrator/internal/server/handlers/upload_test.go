package handlers

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

func TestUploadPreservesCompoundArchiveAndCleansTemporaryFiles(t *testing.T) {
	base := t.TempDir()
	st, err := store.New(filepath.Join(base, "data.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cfg := &config.Config{Storage: config.StorageConfig{AppsDir: filepath.Join(base, "apps"), TempDir: filepath.Join(base, "temp"), MaxUploadSize: 1 << 20, MaxExtractSize: 1 << 20, MaxFileCount: 10}}
	manager := app.NewManager(st, cfg, nil, nil, nil, zap.NewNop())
	handler := NewUploadHandler(manager, cfg, zap.NewNop())
	router := gin.New()
	router.POST("/upload", handler.Upload)
	server := httptest.NewServer(router)
	defer server.Close()
	for _, test := range []struct {
		name    string
		corrupt bool
	}{{"valid", false}, {"corrupt", true}, {"missing-template", false}} {
		t.Run(test.name, func(t *testing.T) {
			var archive bytes.Buffer
			gz := gzip.NewWriter(&archive)
			tr := tar.NewWriter(gz)
			_ = tr.WriteHeader(&tar.Header{Name: "payload.bin", Mode: 0644, Size: 7})
			_, _ = tr.Write([]byte("payload"))
			_ = tr.Close()
			_ = gz.Close()
			data := archive.Bytes()
			if test.corrupt {
				data[len(data)-8] ^= 0xff
			}
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			_ = form.WriteField("name", test.name)
			if test.name == "missing-template" {
				_ = form.WriteField("args_template", "not-configured")
			}
			file, _ := form.CreateFormFile("file", "Application.TAR.GZ")
			_, _ = file.Write(data)
			_ = form.Close()
			response, err := server.Client().Post(server.URL+"/upload", form.FormDataContentType(), &body)
			if err != nil {
				t.Fatal(err)
			}
			responseBody, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if test.name == "missing-template" {
				if response.StatusCode != 400 {
					t.Fatalf("invalid template status: %d %s", response.StatusCode, responseBody)
				}
				files, readErr := os.ReadDir(cfg.Storage.TempDir)
				archives, archiveErr := st.ListUploadArchives()
				record, recordErr := st.GetAppByName(test.name)
				if readErr != nil || archiveErr != nil || recordErr != nil || len(files) != 0 || len(archives) != 0 || record != nil || manager.IsUploading() {
					t.Fatal("rejected template leaked upload ownership or persisted an application")
				}
				return
			}
			if response.StatusCode != 200 {
				t.Fatalf("upload: %d %s", response.StatusCode, responseBody)
			}
			var result struct {
				Data struct {
					ID string `json:"app_id"`
				} `json:"data"`
			}
			if err := json.Unmarshal(responseBody, &result); err != nil {
				t.Fatal(err)
			}
			// No executable is present, so detection should end visibly without launch.
			var record *model.App
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				record, err = st.GetApp(result.Data.ID)
				if err != nil {
					t.Fatal(err)
				}
				files, _ := os.ReadDir(cfg.Storage.TempDir)
				archives, err := st.ListUploadArchives()
				if err != nil {
					t.Fatal(err)
				}
				if record.Status == model.AppStatusError && !manager.IsUploading() && len(files) == 0 && len(archives) == 0 {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if record == nil || record.Status != model.AppStatusError || manager.IsUploading() {
				t.Fatalf("pipeline did not finish: %+v", record)
			}
			files, err := os.ReadDir(cfg.Storage.TempDir)
			if err != nil || len(files) != 0 {
				t.Fatalf("temporary archive leaked: %v %v", files, err)
			}
			if archives, err := st.ListUploadArchives(); err != nil || len(archives) != 0 {
				t.Fatal("upload ownership journal did not settle", err)
			}
			output, err := os.ReadFile(filepath.Join(record.AppDir, "payload.bin"))
			if test.corrupt {
				if !os.IsNotExist(err) {
					t.Fatal("corrupt extraction directory was retained")
				}
			} else if err != nil || string(output) != "payload" {
				t.Fatalf("compound suffix extraction: %q %v", output, err)
			}
		})
	}
}

func TestUploadIdleDeadlineAndCleanupOverTLS(t *testing.T) {
	const idle = 800 * time.Millisecond
	for _, http2 := range []bool{false, true} {
		t.Run(map[bool]string{false: "HTTP1", true: "HTTP2"}[http2], func(t *testing.T) {
			base := t.TempDir()
			st, err := store.New(filepath.Join(base, "state.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			cfg := &config.Config{Storage: config.StorageConfig{AppsDir: filepath.Join(base, "apps"), TempDir: filepath.Join(base, "temp"), MaxUploadSize: 1 << 20, MaxExtractSize: 1 << 20, MaxFileCount: 10}}
			manager := app.NewManager(st, cfg, nil, nil, nil, zap.NewNop())
			defer manager.Shutdown(context.Background())
			h := NewUploadHandler(manager, cfg, zap.NewNop())
			h.idleTimeout = idle
			router := gin.New()
			router.POST("/upload", h.Upload)
			server := httptest.NewUnstartedServer(router)
			server.EnableHTTP2 = http2
			server.StartTLS()
			defer server.Close()
			client := server.Client()
			client.Timeout = 8 * time.Second

			await := func(check func() bool, label string) {
				t.Helper()
				deadline := time.Now().Add(5 * time.Second)
				for !check() {
					if time.Now().After(deadline) {
						t.Fatalf("timed out waiting for %s", label)
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			for _, mode := range []string{"stall", "cancel", "slow"} {
				t.Run(mode, func(t *testing.T) {
					reader, writer := io.Pipe()
					defer reader.Close()
					defer writer.Close()
					form := multipart.NewWriter(writer)
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/upload", reader)
					if err != nil {
						t.Fatal(err)
					}
					req.Header.Set("Content-Type", form.FormDataContentType())
					type result struct {
						status, protocol int
						code             string
						err              error
					}
					done := make(chan result, 1)
					go func() {
						res, err := client.Do(req)
						if err != nil {
							done <- result{err: err}
							return
						}
						defer res.Body.Close()
						var body struct {
							Code string `json:"code"`
						}
						err = json.NewDecoder(res.Body).Decode(&body)
						done <- result{res.StatusCode, res.ProtoMajor, body.Code, err}
					}()
					file, err := form.CreateFormFile("file", "app.tar")
					if err != nil {
						t.Fatal(err)
					}
					if _, err = io.WriteString(file, strings.Repeat("a", 4096)); err != nil {
						t.Fatal(err)
					}
					await(func() bool {
						entries, _ := st.ListUploadArchives()
						return manager.IsUploading() && len(entries) == 1
					}, "streamed archive ownership")
					switch mode {
					case "cancel":
						cancel()
						writer.Close()
					case "slow":
						// Total duration exceeds idle, but each chunk arrives within it.
						for range 6 {
							time.Sleep(160 * time.Millisecond)
							if _, err = io.WriteString(file, strings.Repeat("b", 4096)); err != nil {
								t.Fatal(err)
							}
						}
						if err = form.WriteField("name", "file-first-slow"); err != nil {
							t.Fatal(err)
						}
						if err = form.Close(); err != nil {
							t.Fatal(err)
						}
						writer.Close()
					}
					response := <-done
					want := map[string]int{"stall": 408, "cancel": 0, "slow": 200}[mode]
					if response.status != want || (mode == "cancel" && response.err == nil) ||
						(mode != "cancel" && (response.err != nil || (response.protocol == 2) != http2)) ||
						(mode == "stall" && response.code != "UPLOAD_TIMEOUT") {
						t.Fatalf("unexpected upload result: %+v", response)
					}
					await(func() bool {
						files, fileErr := os.ReadDir(cfg.Storage.TempDir)
						entries, archiveErr := st.ListUploadArchives()
						return !manager.IsUploading() && fileErr == nil && archiveErr == nil && len(files) == 0 && len(entries) == 0
					}, "upload lock, file and journal cleanup")
				})
			}
		})
	}
}

func TestUploadRejectsOversizedMultipartAndReleasesLock(t *testing.T) {
	cfg := &config.Config{Storage: config.StorageConfig{MaxUploadSize: 100}}
	manager := app.NewManager(nil, cfg, nil, nil, nil, zap.NewNop())
	router := gin.New()
	router.POST("/upload", NewUploadHandler(manager, cfg, zap.NewNop()).Upload)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("name", "large")
	file, _ := form.CreateFormFile("file", "app.7z")
	_, _ = file.Write(make([]byte, (1<<20)+200))
	_ = form.Close()
	request := httptest.NewRequest("POST", "/upload", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 413 || manager.IsUploading() {
		t.Fatalf("limit/lock: %d %v", response.Code, manager.IsUploading())
	}
	for _, name := range []string{"app.7z", "app.rar", "app.tar.xz", "app.tar.zst", "app.tar.gz"} {
		if !isAllowedExtension(name) {
			t.Fatal(name)
		}
	}
}

package handlers

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	for _, test := range []struct {
		name    string
		corrupt bool
	}{{"valid", false}, {"corrupt", true}} {
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
			file, _ := form.CreateFormFile("file", "Application.TAR.GZ")
			_, _ = file.Write(data)
			_ = form.Close()
			request := httptest.NewRequest("POST", "/upload", &body)
			request.Header.Set("Content-Type", form.FormDataContentType())
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatalf("upload: %d %s", response.Code, response.Body.String())
			}
			var result struct {
				Data struct {
					ID string `json:"app_id"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
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
				if record.Status == model.AppStatusError && !manager.IsUploading() && len(files) == 0 {
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

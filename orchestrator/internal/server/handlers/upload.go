package handlers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

var allowedExtensions = map[string]bool{
	".zip":    true,
	".tar":    true,
	".tar.gz": true,
	".tgz":    true,
	".tar.bz2": true,
}

type UploadHandler struct {
	Manager *app.Manager
	Config  *config.Config
	Logger  *zap.Logger
}

func NewUploadHandler(mgr *app.Manager, cfg *config.Config, logger *zap.Logger) *UploadHandler {
	return &UploadHandler{Manager: mgr, Config: cfg, Logger: logger}
}

// Upload handles multipart file upload for v1.0.
// tus protocol integration will be added in a future iteration.
// UploadStatus returns whether an upload/extract is currently in progress.
func (h *UploadHandler) UploadStatus(c *gin.Context) {
	okResponse(c, gin.H{"uploading": h.Manager.IsUploading()})
}

func (h *UploadHandler) Upload(c *gin.Context) {
	// Global upload lock — only one upload/extract at a time
	unlockUpload, err := h.Manager.TryLockUpload()
	if err != nil {
		errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
		return
	}
	// Lock spans upload + extract. Released by ProcessUploadComplete on success,
	// or here on early error via pipelineStarted flag.
	pipelineStarted := false
	defer func() {
		if !pipelineStarted {
			unlockUpload()
		}
	}()

	name := c.PostForm("name")
	if name == "" {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "请提供应用名称 (name)")
		return
	}

	argsTemplate := c.PostForm("args_template")
	args := c.PostForm("args")
	exePath := c.PostForm("exe_path")

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "请上传文件 (file)")
		return
	}
	defer file.Close()

	// Validate extension
	filename := header.Filename
	if !isAllowedExtension(filename) {
		errResponse(c, http.StatusBadRequest, "UPLOAD_INVALID_FORMAT",
			fmt.Sprintf("不支持的文件格式。支持: %s", strings.Join(getAllowedExtensions(), ", ")))
		return
	}

	// Check size
	if header.Size > h.Config.Storage.MaxUploadSize {
		errResponse(c, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE",
			fmt.Sprintf("文件大小 %d 超过限制 %d 字节", header.Size, h.Config.Storage.MaxUploadSize))
		return
	}

	// Step 1: Save file to temp FIRST (before creating DB record)
	tempDir := h.Config.Storage.TempDir
	os.MkdirAll(tempDir, 0755)
	tempID := fmt.Sprintf("upload-%d", time.Now().UnixNano())
	tempPath := filepath.Join(tempDir, tempID+filepath.Ext(filename))

	out, err := os.Create(tempPath)
	if err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "创建临时文件失败")
		return
	}

	written, err := io.Copy(out, file)
	out.Close()
	if err != nil {
		os.Remove(tempPath)
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "保存文件失败")
		return
	}

	// Step 2: Create DB record only after file is safely saved
	appRecord, err := h.Manager.CreateApp(name, argsTemplate, args, exePath, written)
	if err != nil {
		os.Remove(tempPath) // cleanup temp file on DB failure
		if strings.Contains(err.Error(), "同名") {
			errResponse(c, http.StatusConflict, "APP_ALREADY_EXISTS", err.Error())
		} else {
			errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		}
		return
	}

	h.Logger.Info("文件上传完成",
		zap.String("app_id", appRecord.ID),
		zap.String("name", name),
		zap.Int64("size", written),
	)

	// Trigger async pipeline: extract → detect → (register)
	pipelineStarted = true
	h.Manager.ProcessUploadComplete(appRecord.ID, tempPath, unlockUpload)

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"data": gin.H{
			"app_id":  appRecord.ID,
			"name":    name,
			"message": "上传成功，正在解压和检测入口...",
		},
		"request_id": getRequestID(c),
	})
}

func isAllowedExtension(filename string) bool {
	lower := strings.ToLower(filename)
	for ext := range allowedExtensions {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

func getAllowedExtensions() []string {
	result := make([]string, 0, len(allowedExtensions))
	for ext := range allowedExtensions {
		result = append(result, ext)
	}
	return result
}

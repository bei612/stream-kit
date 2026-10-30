package handlers

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"go.uber.org/zap"
)

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

	maxSize := h.Config.Storage.MaxUploadSize
	if maxSize <= 0 || maxSize > math.MaxInt64-(1<<20) {
		errResponse(c, http.StatusServiceUnavailable, "CONFIG_INVALID", "上传大小限制无效")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSize+(1<<20))
	parseErr := c.Request.ParseMultipartForm(8 << 20)
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if parseErr != nil {
		var oversized *http.MaxBytesError
		if errors.As(parseErr, &oversized) {
			errResponse(c, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传内容超限")
		} else {
			errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "上传表单无效")
		}
		return
	}
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
	archive, err := h.Manager.CreateUploadArchive(filename)
	if err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "创建临时文件失败")
		return
	}
	defer func() {
		if !pipelineStarted {
			if err := archive.Cleanup(); err != nil {
				h.Logger.Error("上传归档回收失败，将在重启时重试", zap.Error(err))
			}
		}
	}()
	written, copyErr := io.Copy(archive.File, io.LimitReader(file, maxSize+1))
	err = errors.Join(copyErr, archive.File.Close())
	if written > maxSize {
		errResponse(c, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传文件超限")
		return
	}
	if err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "保存文件失败")
		return
	}

	// Step 2: Create DB record only after file is safely saved
	appRecord, err := h.Manager.CreateApp(name, argsTemplate, args, exePath, written, model.CaptureMode(c.PostForm("capture_mode")))
	if err != nil {
		if strings.Contains(err.Error(), "同名") {
			errResponse(c, http.StatusConflict, "APP_ALREADY_EXISTS", err.Error())
		} else if errors.Is(err, app.ErrCaptureModeUnavailable) {
			errResponse(c, http.StatusBadRequest, "CAPTURE_UNAVAILABLE", err.Error())
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
	h.Manager.ProcessUploadComplete(appRecord.ID, archive, unlockUpload)

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
	return app.ArchiveExtension(filename) != ""
}

func getAllowedExtensions() []string {
	return app.SupportedArchiveExtensions()
}

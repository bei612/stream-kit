package handlers

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"go.uber.org/zap"
)

type UploadHandler struct {
	Manager     *app.Manager
	Config      *config.Config
	Logger      *zap.Logger
	idleTimeout time.Duration
}

func NewUploadHandler(mgr *app.Manager, cfg *config.Config, logger *zap.Logger) *UploadHandler {
	return &UploadHandler{Manager: mgr, Config: cfg, Logger: logger, idleTimeout: 60 * time.Second}
}

// Upload handles multipart file upload for v1.0.
// tus protocol integration will be added in a future iteration.
// UploadStatus returns whether an upload/extract is currently in progress.
func (h *UploadHandler) UploadStatus(c *gin.Context) {
	okResponse(c, gin.H{"uploading": h.Manager.IsUploading()})
}

func (h *UploadHandler) Upload(c *gin.Context) {
	maxSize := h.Config.Storage.MaxUploadSize
	if maxSize <= 0 || maxSize > math.MaxInt64-uploadFormAllowance {
		errResponse(c, http.StatusServiceUnavailable, "CONFIG_INVALID", "上传大小限制无效")
		return
	}
	if c.Request.ContentLength > maxSize+uploadFormAllowance {
		errResponse(c, http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传内容超限")
		return
	}
	// A single owner retains the lock through receipt and then extraction.
	unlockUpload, err := h.Manager.TryLockUpload()
	if err != nil {
		errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
		return
	}
	var upload receivedUpload
	handedOff := false
	defer func() {
		if handedOff {
			return
		}
		defer unlockUpload()
		if upload.archive != nil {
			if err := upload.archive.Cleanup(); err != nil {
				h.Logger.Error("上传归档回收失败，将在重启时重试", zap.Error(err))
			}
		}
	}()

	if failure := h.receiveUpload(c, maxSize, &upload); failure != nil {
		errResponse(c, failure.status, failure.code, failure.message)
		return
	}

	name := upload.fields["name"]
	appRecord, err := h.Manager.CreateApp(name, upload.fields["args_template"], upload.fields["args"],
		upload.fields["exe_path"], upload.size, model.CaptureMode(upload.fields["capture_mode"]))
	if err != nil {
		if strings.Contains(err.Error(), "同名") {
			errResponse(c, http.StatusConflict, "APP_ALREADY_EXISTS", err.Error())
		} else if errors.Is(err, app.ErrCaptureModeUnavailable) {
			errResponse(c, http.StatusBadRequest, "CAPTURE_UNAVAILABLE", err.Error())
		} else if errors.Is(err, app.ErrInvalidLaunchArguments) {
			errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", err.Error())
		} else {
			errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		}
		return
	}

	h.Logger.Info("文件上传完成",
		zap.String("app_id", appRecord.ID),
		zap.String("name", name),
		zap.Int64("size", upload.size),
	)

	// Trigger async pipeline: extract → detect → (register)
	handedOff = true
	h.Manager.ProcessUploadComplete(appRecord.ID, upload.archive, unlockUpload)

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

const uploadFormAllowance int64 = 1 << 20
const uploadMaxParts = 1000

type uploadFailure struct {
	status        int
	code, message string
}

type receivedUpload struct {
	archive *app.UploadArchive
	fields  map[string]string
	size    int64
}

// Refresh only on reads, without a new goroutine or an absolute upload duration.
// On HTTP/2 the server implements this as a per-stream deadline.
type uploadBody struct {
	io.ReadCloser
	controller *http.ResponseController
	idle       time.Duration
}

func (r uploadBody) Read(dst []byte) (int, error) {
	if err := r.controller.SetReadDeadline(time.Now().Add(r.idle)); err != nil {
		return 0, err
	}
	return r.ReadCloser.Read(dst)
}

func uploadReadFailure(err error) *uploadFailure {
	var oversized *http.MaxBytesError
	var timeout interface{ Timeout() bool }
	switch {
	case errors.As(err, &oversized):
		return &uploadFailure{http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传内容超限"}
	case errors.As(err, &timeout) && timeout.Timeout():
		return &uploadFailure{http.StatusRequestTimeout, "UPLOAD_TIMEOUT", "上传长时间未收到数据，请检查连接后重试"}
	default:
		return &uploadFailure{http.StatusBadRequest, "CONFIG_INVALID", "上传表单无效或传输未完成"}
	}
}

func (h *UploadHandler) receiveUpload(c *gin.Context, maxSize int64, upload *receivedUpload) *uploadFailure {
	controller := http.NewResponseController(c.Writer)
	complete := false
	defer func() {
		// Do not let HTTP/1.1 try to drain a rejected, potentially stalled body
		// before writing the error response. HTTP/2 ends only the request stream.
		if !complete && c.Request.ProtoMajor == 1 {
			c.Header("Connection", "close")
		}
	}()
	if err := controller.SetReadDeadline(time.Now().Add(h.idleTimeout)); err != nil {
		return &uploadFailure{http.StatusInternalServerError, "INTERNAL_ERROR", "无法设置上传读取时限"}
	}
	c.Request.Body = uploadBody{
		ReadCloser: http.MaxBytesReader(c.Writer, c.Request.Body, maxSize+uploadFormAllowance),
		controller: controller, idle: h.idleTimeout,
	}
	reader, err := c.Request.MultipartReader()
	if err != nil {
		return uploadReadFailure(err)
	}
	upload.fields = make(map[string]string, 5)
	metadataRemaining := uploadFormAllowance
	for count := 0; ; count++ {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return uploadReadFailure(err)
		}
		if count >= uploadMaxParts {
			return &uploadFailure{http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传表单字段过多"}
		}
		if part.FormName() == "file" && part.FileName() != "" {
			if upload.archive != nil {
				return &uploadFailure{http.StatusBadRequest, "CONFIG_INVALID", "每次只能上传一个应用归档"}
			}
			if failure := h.receiveArchive(part.FileName(), part, maxSize, upload); failure != nil {
				return failure
			}
			continue
		}
		field := part.FormName()
		_, alreadySet := upload.fields[field]
		limited := &io.LimitedReader{R: part, N: metadataRemaining + 1}
		switch {
		case part.FileName() == "" && !alreadySet && isUploadField(field):
			var value []byte
			value, err = io.ReadAll(limited)
			upload.fields[field] = string(value)
		default:
			_, err = io.Copy(io.Discard, limited)
		}
		if err != nil {
			return uploadReadFailure(err)
		}
		if limited.N == 0 {
			return &uploadFailure{http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传表单字段超限"}
		}
		metadataRemaining = limited.N - 1
	}
	// Count the epilogue as part of the HTTP body and require transport EOF.
	if _, err := io.Copy(io.Discard, c.Request.Body); err != nil {
		return uploadReadFailure(err)
	}
	if err := controller.SetReadDeadline(time.Time{}); err != nil {
		return &uploadFailure{http.StatusInternalServerError, "INTERNAL_ERROR", "无法清除上传读取时限"}
	}
	complete = true
	if err := c.Request.Context().Err(); err != nil {
		return uploadReadFailure(err)
	}
	if upload.fields["name"] == "" {
		return &uploadFailure{http.StatusBadRequest, "CONFIG_INVALID", "请提供应用名称 (name)"}
	}
	if upload.archive == nil {
		return &uploadFailure{http.StatusBadRequest, "CONFIG_INVALID", "请上传文件 (file)"}
	}
	return nil
}

func isUploadField(name string) bool {
	switch name {
	case "name", "args_template", "args", "exe_path", "capture_mode":
		return true
	default:
		return false
	}
}

func (h *UploadHandler) receiveArchive(filename string, part io.Reader, maxSize int64, upload *receivedUpload) *uploadFailure {
	if !isAllowedExtension(filename) {
		return &uploadFailure{http.StatusBadRequest, "UPLOAD_INVALID_FORMAT",
			fmt.Sprintf("不支持的文件格式。支持: %s", strings.Join(getAllowedExtensions(), ", "))}
	}
	archive, err := h.Manager.CreateUploadArchive(filename)
	if err != nil {
		h.Logger.Warn("创建上传归档失败", zap.Error(err))
		return &uploadFailure{http.StatusInternalServerError, "INTERNAL_ERROR", "创建临时文件失败"}
	}
	upload.archive = archive
	// Read one byte past the file budget for exact-limit detection.
	written, copyErr := io.Copy(archive.File, io.LimitReader(part, maxSize+1))
	closeErr := archive.File.Close()
	if written > maxSize {
		return &uploadFailure{http.StatusRequestEntityTooLarge, "UPLOAD_TOO_LARGE", "上传文件超限"}
	}
	var storageError *os.PathError
	if closeErr != nil || errors.As(copyErr, &storageError) {
		h.Logger.Warn("写入上传归档失败", zap.Error(errors.Join(copyErr, closeErr)))
		return &uploadFailure{http.StatusInternalServerError, "INTERNAL_ERROR", "保存文件失败，请检查服务器可用空间和权限"}
	}
	if copyErr != nil {
		return uploadReadFailure(copyErr)
	}
	upload.size = written
	return nil
}

func isAllowedExtension(filename string) bool {
	return app.ArchiveExtension(filename) != ""
}

func getAllowedExtensions() []string {
	return app.SupportedArchiveExtensions()
}

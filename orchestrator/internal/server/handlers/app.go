package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
)

type AppHandler struct {
	Manager *app.Manager
	Store   *store.Store
	CompMgr *component.Manager
}

func NewAppHandler(mgr *app.Manager, st *store.Store, compMgr *component.Manager) *AppHandler {
	return &AppHandler{Manager: mgr, Store: st, CompMgr: compMgr}
}

func (h *AppHandler) CaptureCapabilities(c *gin.Context) {
	capabilities, err := h.Manager.CaptureCapabilities(c.Request.Context())
	if err != nil {
		errResponse(c, http.StatusServiceUnavailable, "CAPTURE_UNAVAILABLE", err.Error())
		return
	}
	c.Header("Cache-Control", "no-store")
	okResponse(c, capabilities)
}

func (h *AppHandler) RegisterLocal(c *gin.Context) {
	var req app.LocalAppRequest
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16384))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		errResponse(c, 400, "CONFIG_INVALID", "本机程序配置格式错误")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		errResponse(c, 400, "CONFIG_INVALID", "请求包含多余数据")
		return
	}
	record, err := h.Manager.RegisterLocal(req)
	if err != nil {
		if errors.Is(err, app.ErrInvalidLocalApp) {
			errResponse(c, 400, "CONFIG_INVALID", err.Error())
		} else {
			errResponse(c, 500, "INTERNAL_ERROR", "本机程序注册失败")
		}
		return
	}
	c.Header("Cache-Control", "no-store")
	okResponse(c, record)
}

func (h *AppHandler) List(c *gin.Context) {
	apps, err := h.Store.ListApps()
	if err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}
	okResponse(c, apps)
}

func (h *AppHandler) Get(c *gin.Context) {
	id := c.Param("app_id")
	a, err := h.Store.GetApp(id)
	if err != nil {
		errResponse(c, http.StatusNotFound, "APP_NOT_FOUND", "应用不存在")
		return
	}
	okResponse(c, a)
}

func (h *AppHandler) Update(c *gin.Context) {
	id := c.Param("app_id")

	var req struct {
		CaptureMode  *model.CaptureMode `json:"capture_mode"`
		Name         *string            `json:"name"`
		Args         *string            `json:"args"`
		ArgsTemplate *string            `json:"args_template"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16384))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "请求格式错误")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "请求包含多余数据")
		return
	}

	if err := h.Manager.UpdateApp(id, req.Name, req.Args, req.ArgsTemplate, req.CaptureMode); err != nil {
		if errors.Is(err, app.ErrOperationConflict) {
			errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
			return
		}
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", err.Error())
		return
	}

	a, _ := h.Store.GetApp(id)
	okResponse(c, a)
}

func (h *AppHandler) Delete(c *gin.Context) {
	id := c.Param("app_id")
	confirm := c.Query("confirm")
	if confirm != "true" {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "删除操作需要 confirm=true 参数")
		return
	}

	unlock, err := h.Manager.TryLock(id)
	if err != nil {
		errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
		return
	}
	defer unlock()

	if err := h.Manager.DeleteApp(id); err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}

	okResponse(c, gin.H{"message": "应用已删除"})
}

func (h *AppHandler) Candidates(c *gin.Context) {
	id := c.Param("app_id")
	candidates, err := h.Manager.GetCandidates(id)
	if err != nil {
		errResponse(c, http.StatusNotFound, "APP_NOT_FOUND", err.Error())
		return
	}
	okResponse(c, candidates)
}

func (h *AppHandler) SelectExe(c *gin.Context) {
	id := c.Param("app_id")

	unlock, err := h.Manager.TryLock(id)
	if err != nil {
		errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
		return
	}
	defer unlock()

	var req struct {
		ExePath string `json:"exe_path" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "请提供 exe_path")
		return
	}

	if err := h.Manager.SelectExe(id, req.ExePath); err != nil {
		errResponse(c, http.StatusBadRequest, "APP_STATE_INVALID", err.Error())
		return
	}

	a, _ := h.Store.GetApp(id)
	okResponse(c, a)
}

func (h *AppHandler) Status(c *gin.Context) {
	id := c.Param("app_id")
	a, err := h.Store.GetApp(id)
	if err != nil {
		errResponse(c, http.StatusNotFound, "APP_NOT_FOUND", "应用不存在")
		return
	}
	okResponse(c, gin.H{
		"status": a.Status,
	})
}

func (h *AppHandler) Logs(c *gin.Context) {
	id := c.Param("app_id")
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "200"))
	if lines <= 0 || lines > 2000 {
		lines = 200
	}

	logLines, err := h.Manager.ReadLogs(id, lines)
	if err != nil {
		errResponse(c, http.StatusNotFound, "APP_NOT_FOUND", "应用不存在")
		return
	}

	okResponse(c, gin.H{
		"app_id": id,
		"lines":  logLines,
	})
}

func (h *AppHandler) Stop(c *gin.Context) {
	id := c.Param("app_id")

	unlock, err := h.Manager.TryLock(id)
	if err != nil {
		errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
		return
	}
	defer unlock()

	if err := h.Manager.StopApp(id); err != nil {
		errResponse(c, http.StatusBadRequest, "APP_STATE_INVALID", err.Error())
		return
	}
	a, _ := h.Store.GetApp(id)
	okResponse(c, a)
}

func (h *AppHandler) Launch(c *gin.Context) {
	id := c.Param("app_id")

	// Pre-check: components must be running
	if h.CompMgr != nil {
		sunInfo, _ := h.CompMgr.Get("sunshine")
		if sunInfo != nil && sunInfo.Status != component.StatusRunning {
			errResponse(c, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE",
				"串流编码器未运行，请先在组件管理中启动")
			return
		}
		wsInfo, _ := h.CompMgr.Get("web_server")
		if wsInfo != nil && wsInfo.Status != component.StatusRunning {
			errResponse(c, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE",
				"串流网关未运行，请先在组件管理中启动")
			return
		}
	}

	unlock, err := h.Manager.TryLock(id)
	if err != nil {
		errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", err.Error())
		return
	}
	defer unlock()

	streamURL, err := h.Manager.LaunchApp(id)
	if err != nil {
		msg := err.Error()
		if contains(msg, "离线") {
			errResponse(c, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", msg)
		} else if contains(msg, "正在串流") {
			errResponse(c, http.StatusConflict, "APP_OPERATION_CONFLICT", msg)
		} else {
			errResponse(c, http.StatusBadRequest, "APP_STATE_INVALID", msg)
		}
		return
	}

	okResponse(c, gin.H{
		"stream_url": streamURL, // format: "port/path" — frontend prepends hostname
	})
}

func (h *AppHandler) Register(c *gin.Context) {
	id := c.Param("app_id")
	if err := h.Manager.RetryRegister(id); err != nil {
		errResponse(c, http.StatusBadRequest, "APP_STATE_INVALID", err.Error())
		return
	}
	okResponse(c, gin.H{"message": "正在重新注册到编码器..."})
}

package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)

type SystemHandler struct {
	Settings *config.Settings
	Config   *config.Config
	Store    *store.Store
	CompMgr  *component.Manager
	Logger   *zap.Logger
}

func NewSystemHandler(cfg *config.Config, st *store.Store, compMgr *component.Manager, logger *zap.Logger) *SystemHandler {
	return &SystemHandler{Config: cfg, Settings: config.NewSettings(cfg), Store: st, CompMgr: compMgr, Logger: logger}
}

func (h *SystemHandler) Health(c *gin.Context) {
	resp := gin.H{
		"version":    Version,
		"commit":     Commit,
		"build_time": BuildTime,
	}

	// Component statuses
	if h.CompMgr != nil {
		comps := h.CompMgr.GetAll()
		compMap := make(map[string]gin.H)
		for _, cs := range comps {
			compMap[cs.Name] = gin.H{
				"status":      cs.Status,
				"pid":         cs.PID,
				"crash_count": cs.CrashCount,
			}
		}
		resp["components"] = compMap
	}

	// App summary
	apps, err := h.Store.ListApps()
	if err == nil {
		summary := gin.H{"total": len(apps), "running": 0, "ready": 0, "error": 0}
		for _, a := range apps {
			switch a.Status {
			case "running":
				summary["running"] = summary["running"].(int) + 1
			case "ready":
				summary["ready"] = summary["ready"].(int) + 1
			case "error", "crashed", "register_failed":
				summary["error"] = summary["error"].(int) + 1
			}
		}
		resp["apps_summary"] = summary
	}

	c.JSON(http.StatusOK, gin.H{
		"status":     "ok",
		"data":       resp,
		"request_id": getRequestID(c),
	})
}

// Metrics exposes a small Prometheus-compatible surface without adding a
// runtime dependency. It is protected by the API JWT middleware.
func (h *SystemHandler) Metrics(c *gin.Context) {
	apps, _ := h.Store.ListApps()
	running := 0
	for _, app := range apps {
		if app.Status == "running" {
			running++
		}
	}
	c.Header("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(c.Writer, "streamkit_apps_total %d\nstreamkit_apps_running %d\n", len(apps), running)
	if h.CompMgr != nil {
		for _, status := range h.CompMgr.GetAll() {
			fmt.Fprintf(c.Writer, "streamkit_component_crashes_total{component=%q} %d\n", status.Name, status.CrashCount)
		}
	}
}

func (h *SystemHandler) GetConfig(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	okResponse(c, h.Config.Sanitized())
}

func (h *SystemHandler) Configuration(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	var view *config.SettingsView
	var err error
	if c.Request.Method == http.MethodGet {
		view, err = h.Settings.View()
	} else {
		var request struct {
			Revision string                     `json:"revision"`
			Changes  map[string]json.RawMessage `json:"changes"`
		}
		d := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20))
		d.DisallowUnknownFields()
		if d.Decode(&request) != nil || d.Decode(new(any)) != io.EOF {
			errResponse(c, 400, "CONFIG_INVALID", "配置请求格式无效")
			return
		}
		view, err = h.Settings.Save(request.Revision, request.Changes)
	}
	if err != nil {
		switch {
		case errors.Is(err, config.ErrSettingsConflict):
			errResponse(c, 409, "CONFIG_REVISION_CONFLICT", "配置已被修改，请重新读取后再保存")
		case errors.Is(err, config.ErrSettingsUnavailable):
			errResponse(c, 503, "CONFIG_SOURCE_UNAVAILABLE", "当前配置来源不可编辑")
		default:
			errResponse(c, 400, "CONFIG_INVALID", err.Error())
		}
		return
	}
	if c.Request.Method == http.MethodPatch && h.Store != nil {
		h.Store.CreateLog("config", "system", "save", "success", "配置已保存，等待服务重启生效", nil)
	}
	okResponse(c, view)
}

func (h *SystemHandler) GetTemplates(c *gin.Context) {
	okResponse(c, h.Config.Templates)
}

func (h *SystemHandler) GetLogs(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))

	q := store.LogQuery{
		Page:       page,
		Size:       size,
		TargetType: c.Query("target_type"),
		TargetID:   c.Query("target_id"),
		Operation:  c.Query("operation"),
	}

	result, err := h.Store.QueryLogs(q)
	if err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"data":   result.Items,
		"pagination": gin.H{
			"page":  result.Page,
			"size":  result.Size,
			"total": result.Total,
		},
		"request_id": getRequestID(c),
	})
}

package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/component"
)

type ComponentHandler struct {
	Manager *component.Manager
}

func NewComponentHandler(mgr *component.Manager) *ComponentHandler {
	return &ComponentHandler{Manager: mgr}
}

func (h *ComponentHandler) List(c *gin.Context) {
	all := h.Manager.GetAll()
	okResponse(c, all)
}

func (h *ComponentHandler) Get(c *gin.Context) {
	name := c.Param("name")
	cs, err := h.Manager.Get(name)
	if err != nil {
		errResponse(c, http.StatusNotFound, "COMPONENT_NOT_FOUND", "组件不存在: "+name)
		return
	}
	okResponse(c, cs)
}

func (h *ComponentHandler) Start(c *gin.Context) {
	name := c.Param("name")
	if err := h.Manager.Start(name); err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	cs, _ := h.Manager.Get(name)
	okResponse(c, cs)
}

func (h *ComponentHandler) Stop(c *gin.Context) {
	name := c.Param("name")
	if err := h.Manager.Stop(name); err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	cs, _ := h.Manager.Get(name)
	okResponse(c, cs)
}

func (h *ComponentHandler) Restart(c *gin.Context) {
	name := c.Param("name")
	if err := h.Manager.Restart(name); err != nil {
		errResponse(c, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
		return
	}
	cs, _ := h.Manager.Get(name)
	okResponse(c, cs)
}

func (h *ComponentHandler) Logs(c *gin.Context) {
	name := c.Param("name")
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "100"))
	if lines <= 0 || lines > 2000 {
		lines = 100
	}

	buf := h.Manager.GetLogBuffer(name)
	okResponse(c, buf.GetLast(lines))
}

func (h *ComponentHandler) StartAll(c *gin.Context) {
	if !h.Manager.StartAllAsync() {
		errResponse(c, http.StatusConflict, "COMPONENT_OPERATION_CONFLICT", "启动操作正在进行中")
		return
	}
	c.JSON(http.StatusAccepted, gin.H{
		"status":     "ok",
		"data":       h.Manager.GetAll(),
		"message":    "正在启动所有组件，请通过 WebSocket 追踪进度",
		"request_id": getRequestID(c),
	})
}

func (h *ComponentHandler) StopAll(c *gin.Context) {
	if !h.Manager.StopAllAsync() {
		errResponse(c, http.StatusConflict, "COMPONENT_OPERATION_CONFLICT", "停止操作正在进行中")
		return
	}
	c.JSON(http.StatusAccepted, gin.H{
		"status":     "ok",
		"data":       h.Manager.GetAll(),
		"message":    "正在停止所有组件，请通过 WebSocket 追踪进度",
		"request_id": getRequestID(c),
	})
}

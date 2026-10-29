package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/session"
)

type SessionHandler struct{ Manager *session.Manager }

func NewSessionHandler(m *session.Manager) *SessionHandler { return &SessionHandler{Manager: m} }
func (h *SessionHandler) List(c *gin.Context)              { okResponse(c, h.Manager.List()) }
func (h *SessionHandler) Get(c *gin.Context) {
	s, err := h.Manager.Get(c.Param("session_id"))
	if err != nil {
		errResponse(c, http.StatusNotFound, "SESSION_NOT_FOUND", err.Error())
		return
	}
	okResponse(c, s)
}
func (h *SessionHandler) Ensure(c *gin.Context) {
	host, _ := strconv.ParseInt(c.PostForm("host_id"), 10, 64)
	app, _ := strconv.ParseInt(c.PostForm("app_id"), 10, 64)
	if host == 0 || app == 0 {
		var req struct {
			HostID int64 `json:"host_id"`
			AppID  int64 `json:"app_id"`
		}
		if c.ShouldBindJSON(&req) == nil {
			host, app = req.HostID, req.AppID
		}
	}
	if host == 0 || app == 0 {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "host_id and app_id are required")
		return
	}
	okResponse(c, h.Manager.Ensure(host, app))
}

func (h *SessionHandler) Connect(c *gin.Context) {
	var req struct {
		UserID string `json:"user_id"`
	}
	if c.ShouldBindJSON(&req) != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "invalid connection request")
		return
	}
	conn, err := h.Manager.AddConnection(c.Param("session_id"), req.UserID)
	if err != nil {
		errResponse(c, http.StatusConflict, "CONNECTION_REJECTED", err.Error())
		return
	}
	okResponse(c, conn)
}

func (h *SessionHandler) Disconnect(c *gin.Context) {
	if err := h.Manager.Disconnect(c.Param("session_id"), c.Param("connection_id")); err != nil {
		errResponse(c, http.StatusNotFound, "CONNECTION_NOT_FOUND", err.Error())
		return
	}
	okResponse(c, gin.H{"removed": true})
}

func (h *SessionHandler) Heartbeat(c *gin.Context) {
	var req struct {
		Microphone bool `json:"microphone"`
		Live       bool `json:"microphone_live"`
	}
	if c.ShouldBindJSON(&req) != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "invalid heartbeat")
		return
	}
	if err := h.Manager.Heartbeat(c.Param("session_id"), c.Param("connection_id"), req.Microphone, req.Live); err != nil {
		errResponse(c, http.StatusNotFound, "CONNECTION_NOT_FOUND", err.Error())
		return
	}
	okResponse(c, gin.H{"ok": true})
}
func (h *SessionHandler) Claim(c *gin.Context) {
	if err := h.Manager.Claim(c.Param("session_id"), c.Param("connection_id")); err != nil {
		status := http.StatusConflict
		if err == session.ErrNotFound {
			status = http.StatusNotFound
		}
		errResponse(c, status, "CONTROLLER_CHANGE_FAILED", err.Error())
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}
func (h *SessionHandler) Release(c *gin.Context) {
	if err := h.Manager.Release(c.Param("session_id")); err != nil {
		errResponse(c, http.StatusNotFound, "SESSION_NOT_FOUND", err.Error())
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}
func (h *SessionHandler) Audio(c *gin.Context) {
	var cfg session.AudioConfig
	if c.ShouldBindJSON(&cfg) != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "invalid audio config")
		return
	}
	if err := h.Manager.UpdateAudio(c.Param("session_id"), cfg); err != nil {
		errResponse(c, http.StatusNotFound, "SESSION_NOT_FOUND", err.Error())
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}
func (h *SessionHandler) Policy(c *gin.Context) {
	var p session.Policy
	if c.ShouldBindJSON(&p) != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "invalid session policy")
		return
	}
	if err := h.Manager.UpdatePolicy(c.Param("session_id"), p); err != nil {
		if err == session.ErrInvalidState {
			errResponse(c, http.StatusBadRequest, "POLICY_INVALID", err.Error())
			return
		}
		errResponse(c, http.StatusNotFound, "SESSION_NOT_FOUND", err.Error())
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}

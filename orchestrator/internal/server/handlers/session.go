package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/session"
)

// Domain errors have one transport mapping across every session command.
func respondSessionError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, session.ErrPersistence):
		errResponse(c, http.StatusServiceUnavailable, "SESSION_PERSISTENCE_FAILED", "session update could not be committed")
	case errors.Is(err, session.ErrNotFound):
		errResponse(c, http.StatusNotFound, "SESSION_NOT_FOUND", "session or live connection not found")
	case errors.Is(err, session.ErrInvalidState):
		errResponse(c, http.StatusBadRequest, "SESSION_COMMAND_INVALID", "invalid session command")
	case errors.Is(err, session.ErrControllerExists), errors.Is(err, session.ErrControllerChanged), errors.Is(err, session.ErrCapacity), errors.Is(err, session.ErrAudioTargetChanged), errors.Is(err, session.ErrAudioTargetInUse):
		errResponse(c, http.StatusConflict, "SESSION_CONFLICT", err.Error())
	default:
		errResponse(c, http.StatusInternalServerError, "SESSION_INTERNAL_ERROR", "session command failed")
	}
}

type SessionHandler struct {
	ValidateAudioTarget func(context.Context, session.AudioTarget) error
	SyncMedia           func(context.Context) error
	Manager             *session.Manager
	TicketSecret        []byte
}

func (h *SessionHandler) AudioTarget(c *gin.Context) {
	var req struct {
		ExpectedEpoch uint64 `json:"expected_epoch"`
		Target        struct {
			Mode            string `json:"mode"`
			RenderDeviceID  string `json:"render_device_id"`
			CaptureDeviceID string `json:"capture_device_id"`
		} `json:"target"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16384))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil || decoder.Decode(new(any)) != io.EOF || req.ExpectedEpoch == 0 {
		errResponse(c, 400, "AUDIO_TARGET_INVALID", "无效的音频目标配置或配置版本")
		return
	}
	target := session.AudioTarget{Mode: req.Target.Mode, RenderDeviceID: req.Target.RenderDeviceID, CaptureDeviceID: req.Target.CaptureDeviceID}
	if !target.Valid() {
		errResponse(c, 400, "AUDIO_TARGET_INVALID", "请选择有效的目标模式和明确的音频端点")
		return
	}
	current, err := h.Manager.Get(c.Param("session_id"))
	if err != nil {
		respondSessionError(c, err)
		return
	}
	if current.Audio.Target.Epoch != req.ExpectedEpoch {
		respondSessionError(c, session.ErrAudioTargetChanged)
		return
	}
	if h.ValidateAudioTarget == nil {
		errResponse(c, 503, "MEDIA_CONTROL_UNAVAILABLE", "媒体网关尚未配置")
		return
	}
	if err := h.ValidateAudioTarget(c.Request.Context(), target); err != nil {
		if errors.Is(err, session.ErrInvalidState) {
			errResponse(c, 400, "AUDIO_DEVICE_UNAVAILABLE", "所选设备不可用或方向不匹配，请刷新设备目录")
		} else {
			errResponse(c, 503, "MEDIA_CONTROL_UNAVAILABLE", "无法确认媒体网关版本或音频设备状态")
		}
		return
	}
	if err := h.Manager.UpdateAudioTarget(current.ID, req.ExpectedEpoch, target); err != nil {
		respondSessionError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	h.Get(c)
}

func NewSessionHandler(m *session.Manager, ticketSecret []byte) *SessionHandler {
	return &SessionHandler{Manager: m, TicketSecret: ticketSecret}
}
func (h *SessionHandler) List(c *gin.Context) { okResponse(c, h.Manager.List()) }
func (h *SessionHandler) Get(c *gin.Context) {
	s, err := h.Manager.Get(c.Param("session_id"))
	if err != nil {
		respondSessionError(c, err)
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
	s, err := h.Manager.Ensure(host, app)
	if err != nil {
		respondSessionError(c, err)
		return
	}
	okResponse(c, s)
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
		respondSessionError(c, err)
		return
	}
	okResponse(c, conn)
}

func (h *SessionHandler) Disconnect(c *gin.Context) {
	if err := h.Manager.Disconnect(c.Param("session_id"), c.Param("connection_id")); err != nil {
		respondSessionError(c, err)
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
		respondSessionError(c, err)
		return
	}
	okResponse(c, gin.H{"ok": true})
}

func (h *SessionHandler) MediaTicket(c *gin.Context) {
	if h.SyncMedia == nil {
		errResponse(c, http.StatusServiceUnavailable, "MEDIA_CONTROL_UNAVAILABLE", "media control is not configured")
		return
	}
	if err := h.SyncMedia(c.Request.Context()); err != nil {
		errResponse(c, http.StatusServiceUnavailable, "MEDIA_CONTROL_UNAVAILABLE", "media state has not been acknowledged")
		return
	}
	if len(h.TicketSecret) == 0 {
		errResponse(c, http.StatusServiceUnavailable, "MEDIA_TICKET_DISABLED", "media ticket signing is not configured")
		return
	}
	s, err := h.Manager.Get(c.Param("session_id"))
	if err != nil {
		respondSessionError(c, err)
		return
	}
	connection, ok := s.Connections[c.Param("connection_id")]
	if !ok {
		errResponse(c, http.StatusNotFound, "CONNECTION_NOT_FOUND", "connection not found")
		return
	}
	now := time.Now().UTC()
	if !now.Before(connection.ExpiresAt) {
		errResponse(c, http.StatusGone, "CONNECTION_EXPIRED", "connection lease has expired")
		return
	}
	ticket := SignMediaTicket(MediaTicketClaims{
		Purpose: "stream-media", SessionID: s.ID, ConnectionID: connection.ID,
		HostID: s.HostID, AppID: s.AppID, Role: connection.Role,
		Iat: now.Unix(), Exp: now.Add(2 * time.Minute).Unix(),
	}, h.TicketSecret)
	okResponse(c, gin.H{"ticket": ticket, "expires_at": now.Add(2 * time.Minute).Format(time.RFC3339), "role": connection.Role})
}
func (h *SessionHandler) Claim(c *gin.Context) {
	if err := h.Manager.Claim(c.Param("session_id"), c.Param("connection_id")); err != nil {
		respondSessionError(c, err)
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}
func (h *SessionHandler) Release(c *gin.Context) {
	if err := h.Manager.Release(c.Param("session_id")); err != nil {
		respondSessionError(c, err)
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}
func (h *SessionHandler) Transfer(c *gin.Context) {
	var req struct {
		ExpectedControllerID *string `json:"expected_controller_connection_id"`
		ExpectedControlEpoch uint64  `json:"expected_control_epoch"`
	}
	if c.ShouldBindJSON(&req) != nil || req.ExpectedControllerID == nil || req.ExpectedControlEpoch == 0 {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "expected controller and control epoch are required")
		return
	}
	if err := h.Manager.Transfer(c.Param("session_id"), c.Param("connection_id"), *req.ExpectedControllerID, req.ExpectedControlEpoch); err != nil {
		respondSessionError(c, err)
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
		respondSessionError(c, err)
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
			respondSessionError(c, err)
			return
		}
		respondSessionError(c, err)
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}

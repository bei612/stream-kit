package handlers

import (
	"context"
	"errors"
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
	EnsureViewingSession func(context.Context, int64, int64, time.Time) (*session.RenderSession, error)
	ValidateAudioTarget  func(context.Context, session.AudioTarget) error
	SyncMedia            func(context.Context) error
	Manager              *session.Manager
	TicketSecret         []byte
}

func (h *SessionHandler) AudioTarget(c *gin.Context) {
	var req struct {
		ExpectedEpoch uint64 `json:"expected_epoch"`
		Target        struct {
			NodeID          string `json:"node_id"`
			Mode            string `json:"mode"`
			RenderDeviceID  string `json:"render_device_id"`
			CaptureDeviceID string `json:"capture_device_id"`
		} `json:"target"`
	}
	if err := decodeRequestJSON(c, &req, 16384, true); err != nil || req.ExpectedEpoch == 0 {
		requestError(c, err, "AUDIO_TARGET_INVALID", "无效的音频目标配置或配置版本")
		return
	}
	target := session.AudioTarget{NodeID: req.Target.NodeID, Mode: req.Target.Mode, RenderDeviceID: req.Target.RenderDeviceID, CaptureDeviceID: req.Target.CaptureDeviceID}
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
	return &SessionHandler{Manager: m, TicketSecret: ticketSecret, EnsureViewingSession: func(_ context.Context, host, app int64, until time.Time) (*session.RenderSession, error) {
		return m.EnsureAdmission(host, app, until)
	}}
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
	var host, app int64
	switch c.ContentType() {
	case "application/x-www-form-urlencoded", "multipart/form-data":
		var err error
		if c.ContentType() == "multipart/form-data" {
			err = c.Request.ParseMultipartForm(1 << 20)
			if c.Request.MultipartForm != nil {
				defer c.Request.MultipartForm.RemoveAll()
			}
		} else {
			err = c.Request.ParseForm()
		}
		if err != nil {
			requestError(c, err, "CONFIG_INVALID", "invalid session request")
			return
		}
		host, _ = strconv.ParseInt(c.Request.PostForm.Get("host_id"), 10, 64)
		app, _ = strconv.ParseInt(c.Request.PostForm.Get("app_id"), 10, 64)
	default:
		var req struct {
			HostID int64 `json:"host_id"`
			AppID  int64 `json:"app_id"`
		}
		if err := decodeRequestJSON(c, &req, 0, false); err != nil {
			requestError(c, err, "CONFIG_INVALID", "host_id and app_id are required")
			return
		}
		host, app = req.HostID, req.AppID
	}
	if host == 0 || app == 0 {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "host_id and app_id are required")
		return
	}
	s, err := h.EnsureViewingSession(c.Request.Context(), host, app, time.Time{})
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
	if err := decodeRequestJSON(c, &req, 0, false); err != nil {
		requestError(c, err, "CONFIG_INVALID", "invalid connection request")
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
	if err := decodeRequestJSON(c, &req, 0, false); err != nil {
		requestError(c, err, "CONFIG_INVALID", "invalid heartbeat")
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
	if len(h.TicketSecret) == 0 {
		errResponse(c, http.StatusServiceUnavailable, "MEDIA_TICKET_DISABLED", "media ticket signing is not configured")
		return
	}
	now := time.Now().UTC().Truncate(time.Second)
	expires := now.Add(2 * time.Minute)
	if err := h.Manager.ReserveMediaAdmission(c.Param("session_id"), c.Param("connection_id"), expires); err != nil {
		respondSessionError(c, err)
		return
	}
	if err := h.SyncMedia(c.Request.Context()); err != nil {
		errResponse(c, http.StatusServiceUnavailable, "MEDIA_CONTROL_UNAVAILABLE", "media state has not been acknowledged")
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
	if !time.Now().Before(connection.ExpiresAt) || !time.Now().Before(expires) {
		errResponse(c, http.StatusGone, "CONNECTION_EXPIRED", "connection lease has expired")
		return
	}
	ticket := SignMediaTicket(MediaTicketClaims{
		Purpose: "stream-media", SessionID: s.ID, ConnectionID: connection.ID,
		HostID: s.HostID, AppID: s.AppID, Role: connection.Role,
		Iat: now.Unix(), Exp: expires.Unix(),
	}, h.TicketSecret)
	okResponse(c, gin.H{"ticket": ticket, "expires_at": expires.Format(time.RFC3339), "role": connection.Role})
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
	if err := decodeRequestJSON(c, &req, 0, false); err != nil || req.ExpectedControllerID == nil || req.ExpectedControlEpoch == 0 {
		requestError(c, err, "CONFIG_INVALID", "expected controller and control epoch are required")
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
	var req struct {
		session.AudioConfig
		Expected *session.AudioConfig `json:"expected_audio"`
	}
	if err := decodeRequestJSON(c, &req, 0, false); err != nil || req.Expected == nil {
		requestError(c, err, "CONFIG_INVALID", "invalid audio config")
		return
	}
	if err := h.Manager.CompareAndSetAudio(c.Param("session_id"), req.AudioConfig, *req.Expected); err != nil {
		if errors.Is(err, session.ErrAudioChanged) {
			errResponse(c, http.StatusConflict, "AUDIO_CONFIGURATION_CONFLICT", "音频配置已变化，请载入最新配置后重新编辑")
			return
		}
		respondSessionError(c, err)
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}
func (h *SessionHandler) Policy(c *gin.Context) {
	var req struct {
		session.Policy
		Expected *session.Policy `json:"expected_policy"`
	}
	if err := decodeRequestJSON(c, &req, 0, false); err != nil || req.Expected == nil {
		requestError(c, err, "CONFIG_INVALID", "invalid session policy")
		return
	}
	if err := h.Manager.CompareAndSetPolicy(c.Param("session_id"), req.Policy, *req.Expected); err != nil {
		if errors.Is(err, session.ErrPolicyChanged) {
			errResponse(c, http.StatusConflict, "SESSION_POLICY_CONFLICT", "连接配置已变化，请载入最新配置后重新编辑")
			return
		}
		respondSessionError(c, err)
		return
	}
	s, _ := h.Manager.Get(c.Param("session_id"))
	okResponse(c, s)
}

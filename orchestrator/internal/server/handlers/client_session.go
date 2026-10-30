package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/identity"
	"github.com/stream-kit/orchestrator/internal/session"
)

// ClientSessionHandler adapts restricted browser commands to the same session
// domain used by administration. It does not maintain a second session registry.
type ClientSessionHandler struct {
	GatewayPublicURL string
	sessions         *SessionHandler
	invitationKey    []byte
	connectionKey    []byte
}

type ViewingInvitation struct {
	Invitation       string    `json:"invitation"`
	SessionID        string    `json:"session_id"`
	HostID           int64     `json:"host_id"`
	AppID            int64     `json:"app_id"`
	GatewayPublicURL string    `json:"gateway_public_url"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type ClientConnectionState struct {
	SessionID       string              `json:"session_id"`
	HostID          int64               `json:"host_id"`
	AppID           int64               `json:"app_id"`
	Revision        uint64              `json:"revision"`
	Connection      *session.Connection `json:"connection"`
	Audio           ClientAudioPolicy   `json:"audio"`
	ConnectionToken string              `json:"connection_token"`
	TokenExpiresAt  time.Time           `json:"token_expires_at"`
}

// Viewer state is an explicit projection. Native endpoint identities and future
// administrator-only audio settings never travel with a connection capability.
type ClientAudioPolicy struct {
	ProgramGainDB          float64 `json:"program_gain_db"`
	MicrophoneGainDB       float64 `json:"microphone_gain_db"`
	MicrophoneEnabled      bool    `json:"microphone_enabled"`
	BroadcastControllerMic bool    `json:"broadcast_controller_microphone"`
	ControllerMonitor      bool    `json:"controller_monitor"`
}

func clientAudioPolicy(audio session.AudioConfig) ClientAudioPolicy {
	return ClientAudioPolicy{audio.ProgramGainDB, audio.MicrophoneGainDB, audio.MicrophoneEnabled, audio.BroadcastControllerMic, audio.ControllerMonitor}
}

func NewClientSessionHandler(sessions *SessionHandler, secret []byte) *ClientSessionHandler {
	return &ClientSessionHandler{sessions: sessions,
		invitationKey: identity.DeriveKey(secret, identity.Invitation),
		connectionKey: identity.DeriveKey(secret, identity.Connection)}
}

func bearer(c *gin.Context) string {
	value := c.GetHeader("Authorization")
	if !strings.HasPrefix(value, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(value, "Bearer ")
}

// Invite is mounted only behind management authentication. The invitation is
// valid for two minutes and admits viewers to exactly one rendering session.
func (h *ClientSessionHandler) Invite(c *gin.Context) {
	if h.sessions.SyncMedia == nil || len(h.sessions.TicketSecret) == 0 {
		errResponse(c, 503, "MEDIA_CONTROL_UNAVAILABLE", "managed streaming is not configured")
		return
	}
	var req struct {
		HostID int64 `json:"host_id"`
		AppID  int64 `json:"app_id"`
	}
	if c.ShouldBindJSON(&req) != nil {
		errResponse(c, 400, "CONFIG_INVALID", "host_id and app_id are required")
		return
	}
	s, err := h.sessions.EnsureViewingSession(c.Request.Context(), req.HostID, req.AppID)
	if err != nil {
		respondSessionError(c, err)
		return
	}
	now := time.Now().UTC()
	token := identity.Sign(identity.Invitation, identity.Claims{Subject: c.GetString("username"), SessionID: s.ID, IssuedAt: now.Unix(), ExpiresAt: now.Add(2 * time.Minute).Unix()}, h.invitationKey)
	c.Header("Cache-Control", "no-store")
	okResponse(c, ViewingInvitation{Invitation: token, SessionID: s.ID, HostID: s.HostID, AppID: s.AppID, GatewayPublicURL: h.GatewayPublicURL, ExpiresAt: now.Add(2 * time.Minute)})
}

func (h *ClientSessionHandler) Join(c *gin.Context) {
	claims, err := identity.Verify(bearer(c), identity.Invitation, h.invitationKey, time.Now())
	if err != nil {
		errResponse(c, 401, "INVITATION_INVALID", "invitation is invalid or expired")
		return
	}
	// Client-supplied labels never become authenticated identities.
	connection, err := h.sessions.Manager.AddConnection(claims.SessionID, "guest:"+uuid.NewString())
	if err != nil {
		respondSessionError(c, err)
		return
	}
	s, err := h.sessions.Manager.Get(claims.SessionID)
	if err != nil {
		respondSessionError(c, err)
		return
	}
	h.respondConnection(c, s, connection)
}

// Authorize rejects other credential kinds, cross-connection requests and
// revoked/expired leases before the endpoint can inspect or mutate a session.
func (h *ClientSessionHandler) Authorize() gin.HandlerFunc {
	return func(c *gin.Context) {
		claims, err := identity.Verify(bearer(c), identity.Connection, h.connectionKey, time.Now())
		if err != nil || claims.SessionID != c.Param("session_id") || claims.ConnectionID != c.Param("connection_id") {
			errResponse(c, http.StatusUnauthorized, "CONNECTION_UNAUTHORIZED", "connection credential is invalid")
			c.Abort()
			return
		}
		s, err := h.sessions.Manager.Get(claims.SessionID)
		if err != nil {
			errResponse(c, 410, "CONNECTION_EXPIRED", "connection is no longer active")
			c.Abort()
			return
		}
		conn, ok := s.Connections[claims.ConnectionID]
		// Explicit disconnect also revokes dormant recovery authority. Other
		// commands still require a live lease and cannot use this exception.
		disconnecting := c.Request.Method == http.MethodDelete
		if !ok && disconnecting {
			conn, ok = s.Resumable[claims.ConnectionID]
		}
		if !ok || conn.UserID != claims.Subject || (!disconnecting && !time.Now().Before(conn.ExpiresAt)) || s.State == session.StateStopped || s.State == session.StateStopping {
			errResponse(c, 410, "CONNECTION_EXPIRED", "connection is no longer active")
			c.Abort()
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

func (h *ClientSessionHandler) Current(c *gin.Context) {
	s, err := h.sessions.Manager.Get(c.Param("session_id"))
	if err != nil {
		respondSessionError(c, err)
		return
	}
	conn, ok := s.Connections[c.Param("connection_id")]
	if !ok {
		respondSessionError(c, session.ErrNotFound)
		return
	}
	h.respondConnection(c, s, conn)
}

func (h *ClientSessionHandler) Heartbeat(c *gin.Context) {
	var req struct {
		Microphone bool `json:"microphone"`
		Live       bool `json:"microphone_live"`
	}
	if c.ShouldBindJSON(&req) != nil {
		errResponse(c, 400, "CONFIG_INVALID", "invalid heartbeat")
		return
	}
	if err := h.sessions.Manager.Heartbeat(c.Param("session_id"), c.Param("connection_id"), req.Microphone, req.Live); err != nil {
		respondSessionError(c, err)
		return
	}
	h.Current(c)
}

// Resume validates the connection capability independently of the live lease.
// It cannot authenticate an invitation, another connection, or an expired token.
func (h *ClientSessionHandler) Resume(c *gin.Context) {
	claims, err := identity.Verify(bearer(c), identity.Connection, h.connectionKey, time.Now())
	if err != nil || claims.SessionID != c.Param("session_id") || claims.ConnectionID != c.Param("connection_id") {
		errResponse(c, 401, "CONNECTION_UNAUTHORIZED", "connection credential is invalid")
		return
	}
	conn, err := h.sessions.Manager.ResumeConnection(claims.SessionID, claims.ConnectionID, claims.Subject)
	if errors.Is(err, session.ErrNotFound) || errors.Is(err, session.ErrInvalidState) {
		errResponse(c, 410, "CONNECTION_EXPIRED", "connection can no longer resume; open a new viewing link")
		return
	}
	if err != nil {
		respondSessionError(c, err)
		return
	}
	s, err := h.sessions.Manager.Get(claims.SessionID)
	if err != nil {
		respondSessionError(c, err)
		return
	}
	h.respondConnection(c, s, conn)
}

func (h *ClientSessionHandler) respondConnection(c *gin.Context, s *session.RenderSession, conn *session.Connection) {
	now := time.Now().UTC()
	token := identity.Sign(identity.Connection, identity.Claims{Subject: conn.UserID, SessionID: s.ID, ConnectionID: conn.ID, IssuedAt: now.Unix(), ExpiresAt: now.Add(15 * time.Minute).Unix()}, h.connectionKey)
	c.Header("Cache-Control", "no-store")
	okResponse(c, ClientConnectionState{SessionID: s.ID, HostID: s.HostID, AppID: s.AppID, Revision: s.Revision,
		Connection: conn, Audio: clientAudioPolicy(s.Audio), ConnectionToken: token, TokenExpiresAt: now.Add(15 * time.Minute)})
}

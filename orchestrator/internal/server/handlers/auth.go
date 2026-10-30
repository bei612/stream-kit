package handlers

import (
	"crypto/sha256"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/identity"
)

const jwtExpiration = 24 * time.Hour

type Claims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
	Iat int64  `json:"iat"`
}

type MediaTicketClaims struct {
	Purpose      string `json:"purpose"`
	SessionID    string `json:"session_id"`
	ConnectionID string `json:"connection_id"`
	HostID       int64  `json:"host_id"`
	AppID        int64  `json:"app_id"`
	Role         string `json:"role"`
	Exp          int64  `json:"exp"`
	Iat          int64  `json:"iat"`
}

// ResolveJWTSecret returns the JWT signing key.
// If a dedicated jwt_secret is configured, use it. Otherwise derive from password (legacy).
func ResolveJWTSecret(configuredSecret, password string) []byte {
	src := configuredSecret
	if src == "" {
		src = password + ":orchestrator-jwt-secret"
	}
	h := sha256.Sum256([]byte(src))
	return h[:]
}

func signJWT(claims Claims, secret []byte) string {
	return identity.Sign(identity.Management, claims, secret)
}

func VerifyJWT(token string, secret []byte) (*Claims, error) {
	var claims Claims
	if identity.Decode(token, identity.Management, secret, &claims) != nil ||
		claims.Sub == "" || !identity.ValidTime(claims.Iat, claims.Exp, int64(jwtExpiration/time.Second), time.Now()) {
		return nil, identity.ErrCredential
	}
	return &claims, nil
}

func SignMediaTicket(claims MediaTicketClaims, secret []byte) string {
	return identity.Sign(identity.Media, claims, secret)
}

func VerifyMediaTicket(token string, secret []byte) (*MediaTicketClaims, error) {
	var claims MediaTicketClaims
	if identity.Decode(token, identity.Media, secret, &claims) != nil ||
		claims.Purpose != "stream-media" || claims.SessionID == "" || claims.ConnectionID == "" ||
		(claims.Role != "viewer" && claims.Role != "controller") ||
		!identity.ValidTime(claims.Iat, claims.Exp, 120, time.Now()) {
		return nil, identity.ErrCredential
	}
	return &claims, nil
}

// --- Rate Limiter (IP-based, in-memory) ---

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rlEntry
	limit   int
	window  time.Duration
}

type rlEntry struct {
	count   int
	resetAt time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		entries: make(map[string]*rlEntry),
		limit:   limit,
		window:  window,
	}
	// Background cleanup every 5 minutes
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			rl.cleanup()
		}
	}()
	return rl
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	e, ok := rl.entries[ip]
	if !ok || now.After(e.resetAt) {
		rl.entries[ip] = &rlEntry{count: 1, resetAt: now.Add(rl.window)}
		return true
	}
	e.count++
	return e.count <= rl.limit
}

func (rl *rateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	for ip, e := range rl.entries {
		if now.After(e.resetAt) {
			delete(rl.entries, ip)
		}
	}
}

// --- Auth Handler ---

type AuthHandler struct {
	Username  string
	Password  string
	JWTSecret []byte
	limiter   *rateLimiter
}

func NewAuthHandler(username, password string, jwtSecret []byte) *AuthHandler {
	return &AuthHandler{
		Username:  username,
		Password:  password,
		JWTSecret: jwtSecret,
		limiter:   newRateLimiter(10, 5*time.Minute), // 10 attempts per 5 minutes per IP
	}
}

func (h *AuthHandler) Login(c *gin.Context) {
	// Rate limit check
	if !h.limiter.allow(c.ClientIP()) {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"status":     "error",
			"code":       "RATE_LIMITED",
			"message":    "登录尝试过于频繁，请 5 分钟后重试",
			"request_id": getRequestID(c),
		})
		return
	}

	var req struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		errResponse(c, http.StatusBadRequest, "CONFIG_INVALID", "请提供用户名和密码")
		return
	}

	if req.Username != h.Username || req.Password != h.Password {
		errResponse(c, http.StatusUnauthorized, "UNAUTHORIZED", "用户名或密码错误")
		return
	}

	now := time.Now()
	claims := Claims{
		Sub: req.Username,
		Iat: now.Unix(),
		Exp: now.Add(jwtExpiration).Unix(),
	}
	token := signJWT(claims, h.JWTSecret)

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"data": gin.H{
			"token":      token,
			"expires_at": now.Add(jwtExpiration).Format(time.RFC3339),
		},
		"request_id": getRequestID(c),
	})
}

package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const jwtExpiration = 24 * time.Hour

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

type Claims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
	Iat int64  `json:"iat"`
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
	hdr, _ := json.Marshal(jwtHeader{Alg: "HS256", Typ: "JWT"})
	payload, _ := json.Marshal(claims)

	seg1 := base64.RawURLEncoding.EncodeToString(hdr)
	seg2 := base64.RawURLEncoding.EncodeToString(payload)
	sigInput := seg1 + "." + seg2

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(sigInput))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return sigInput + "." + sig
}

func VerifyJWT(tokenStr string, secret []byte) (*Claims, error) {
	parts := strings.SplitN(tokenStr, ".", 3)
	if len(parts) != 3 {
		return nil, errors.New("invalid token format")
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
		return nil, errors.New("invalid signature")
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("unmarshal claims: %w", err)
	}

	if time.Now().Unix() > claims.Exp {
		return nil, errors.New("token expired")
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

package server

import (
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	cfgpkg "github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
)

const RequestIDKey = "request_id"

const controlRequestMaxBytes int64 = 1 << 20

// Every control API body has an allocation boundary, including unknown JSON
// fields and chunked requests. Individual handlers may impose tighter limits.
// Only the registered archive-upload route gets the configured file budget.
func RequestBodyBudget(maxUploadBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := controlRequestMaxBytes
		if c.Request.Method == http.MethodPost && c.FullPath() == "/api/v1/apps/upload" {
			if maxUploadBytes <= 0 || maxUploadBytes > math.MaxInt64-controlRequestMaxBytes {
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"status": "error", "code": "CONFIG_INVALID", "message": "上传大小限制无效", "request_id": getReqID(c)})
				return
			}
			limit = maxUploadBytes + controlRequestMaxBytes
		}
		if c.Request.ContentLength > limit {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"status": "error", "code": "REQUEST_TOO_LARGE", "message": "请求内容超限", "request_id": getReqID(c)})
			return
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

func getReqID(c *gin.Context) string {
	if id, ok := c.Get(RequestIDKey); ok {
		return id.(string)
	}
	return ""
}

func RequestIDMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := uuid.New().String()[:8]
		reqID := "req-" + id
		c.Set(RequestIDKey, reqID)
		c.Header("X-Request-ID", reqID)
		c.Next()
	}
}

// JWTAuthMiddleware accepts management credentials from the Authorization
// header or the browser's versioned WebSocket upgrade header. Never accept URL
// credentials: URLs can be retained by proxies and access logs.
func JWTAuthMiddleware(jwtSecret []byte) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := ""

		// Check Authorization header
		auth := c.GetHeader("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		}

		// Browser WebSocket requests cannot set an Authorization header.
		if token == "" && c.Request.URL.Path == "/api/v1/ws" {
			token = ws.UpgradeCredential(c.Request)
		}

		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"status":     "error",
				"code":       "UNAUTHORIZED",
				"message":    "请先登录",
				"request_id": getReqID(c),
			})
			return
		}

		claims, err := handlers.VerifyJWT(token, jwtSecret)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"status":     "error",
				"code":       "UNAUTHORIZED",
				"message":    "登录已过期，请重新登录",
				"request_id": getReqID(c),
			})
			return
		}

		c.Set("username", claims.Sub)
		c.Set(handlers.ManagementExpiresAt, claims.Exp)
		c.Next()
	}
}

func AccessLogMiddleware(logger *zap.Logger, cfg cfgpkg.AccessLogConfig) gin.HandlerFunc {
	excludeSet := make(map[string]bool)
	for _, p := range cfg.ExcludePaths {
		excludeSet[p] = true
	}

	return func(c *gin.Context) {
		if !cfg.Enabled {
			c.Next()
			return
		}

		path := c.Request.URL.Path
		if excludeSet[path] {
			c.Next()
			return
		}

		start := time.Now()
		c.Next()
		latency := time.Since(start)

		logger.Info("HTTP request",
			zap.String("request_id", getReqID(c)),
			zap.String("method", c.Request.Method),
			zap.String("path", path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("latency", latency),
			zap.String("client_ip", c.ClientIP()),
		)
	}
}

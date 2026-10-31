package server

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
)

type Server struct {
	MediaControl *mediacontrol.Publisher
	Engine       *gin.Engine
	Config       *config.Config
	Store        *store.Store
	Logger       *zap.Logger
	CompManager  *component.Manager
	AppManager   *app.Manager
	WSHub        *ws.Hub
	SessionMgr   *session.Manager
}

func New(cfg *config.Config, st *store.Store, compMgr *component.Manager, appMgr *app.Manager, wsHub *ws.Hub, sessionMgr *session.Manager, logger *zap.Logger) *Server {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	engine.Use(gin.Recovery())

	s := &Server{
		MediaControl: mediacontrol.New(sessionMgr, cfg.MoonlightWeb.BaseURL, cfg.Server.MediaTicketSecret),
		Engine:       engine,
		Config:       cfg,
		Store:        st,
		CompManager:  compMgr,
		AppManager:   appMgr,
		WSHub:        wsHub,
		SessionMgr:   sessionMgr,
		Logger:       logger,
	}

	if appMgr != nil {
		var syncMedia func(context.Context) error
		if s.MediaControl != nil {
			syncMedia = s.MediaControl.Sync
		}
		appMgr.ConfigureSessionLifecycle(sessionMgr, syncMedia)
	}
	s.setupMiddleware()
	s.setupRoutes()
	s.setupSPA()

	return s
}

func (s *Server) setupMiddleware() {
	s.Engine.Use(RequestIDMiddleware())
	s.Engine.Use(AccessLogMiddleware(s.Logger, s.Config.Log.AccessLog))
	s.Engine.Use(CORSMiddleware(s.Config.Server.CORSOrigins))
	// Auth middleware applied to /api/v1/ group below
}

func (s *Server) setupRoutes() {
	api := s.Engine.Group("/api/v1")

	// Public endpoints (no auth)
	h := handlers.NewSystemHandler(s.Config, s.Store, s.CompManager, s.Logger)
	api.GET("/health", h.Health)

	jwtSecret := handlers.ResolveJWTSecret(s.Config.Server.JWTSecret, s.Config.Server.Password)
	authHandler := handlers.NewAuthHandler(s.Config.Server.Username, s.Config.Server.Password, jwtSecret)
	api.POST("/login", authHandler.Login)

	// All other endpoints require JWT auth
	authed := api.Group("")
	authed.Use(JWTAuthMiddleware(jwtSecret))

	authed.GET("/config", h.GetConfig)
	authed.GET("/configuration", h.Configuration)
	authed.PATCH("/configuration", h.Configuration)
	s.registerRenderNodes(authed)
	authed.GET("/templates", h.GetTemplates)
	authed.GET("/logs", h.GetLogs)
	authed.GET("/metrics", h.Metrics)
	var encoderConfiguration handlers.EncoderConfigurationClient
	var encoderState handlers.EncoderStateClient
	if s.Config.SunshineAPI.BaseURL != "" {
		client := sunshine.NewClient(s.Config.SunshineAPI, s.Logger)
		encoderConfiguration = client
		encoderState = client
	}
	authed.GET("/encoder-configuration", handlers.EncoderConfiguration(encoderConfiguration))
	authed.PATCH("/encoder-configuration", handlers.EncoderConfiguration(encoderConfiguration))
	var gatewayConfiguration handlers.GatewayConfigurationClient
	if s.MediaControl != nil {
		gatewayConfiguration = s.MediaControl
	}
	authed.GET("/gateway-configuration", handlers.GatewayConfiguration(gatewayConfiguration))
	authed.PATCH("/gateway-configuration", handlers.GatewayConfiguration(gatewayConfiguration))
	var gatewayRestarter handlers.ComponentRestarter
	if s.CompManager != nil {
		gatewayRestarter = s.CompManager
	}
	authed.POST("/encoder-configuration/apply", handlers.EncoderConfigurationApply(encoderState, gatewayRestarter, s.Config.SunshineAPI.BaseURL))
	authed.POST("/gateway-configuration/apply", handlers.GatewayConfigurationApply(gatewayConfiguration, gatewayRestarter, s.Config.MoonlightWeb.BaseURL))
	authed.GET("/audio-devices", func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if s.MediaControl == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "error", "code": "media_unconfigured", "message": "尚未配置媒体网关连接"})
			return
		}
		inventory, err := s.MediaControl.AudioDevices(c.Request.Context())
		if err != nil {
			s.Logger.Warn("audio device inventory unavailable", zap.Error(err))
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "error", "code": "audio_inventory_unavailable", "message": "无法读取音频设备，请检查媒体网关连接、版本与设备状态"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok", "data": inventory})
	})
	var pairChecker handlers.AudioPairChecker
	if s.MediaControl != nil {
		pairChecker = s.MediaControl
	}
	authed.POST("/audio-devices/check-pair", handlers.AudioPairCheck(pairChecker))

	// Same management identity; browser bearer travels in the upgrade header.
	if s.WSHub != nil {
		wsh := handlers.NewWSHandler(s.WSHub, s.Logger)
		authed.GET("/ws", wsh.Handle)
	}

	// App management
	if s.AppManager != nil {
		ah := handlers.NewAppHandler(s.AppManager, s.Store, s.CompManager)
		uh := handlers.NewUploadHandler(s.AppManager, s.Config, s.Logger)

		authed.POST("/apps/upload", uh.Upload)
		authed.POST("/apps/local", ah.RegisterLocal)
		authed.GET("/apps/upload-status", uh.UploadStatus)
		authed.GET("/apps/capture-capabilities", ah.CaptureCapabilities)
		apps := authed.Group("/apps")
		apps.GET("", ah.List)
		apps.GET("/:app_id", ah.Get)
		apps.PUT("/:app_id", ah.Update)
		apps.DELETE("/:app_id", ah.Delete)
		apps.GET("/:app_id/candidates", ah.Candidates)
		apps.PUT("/:app_id/exe", ah.SelectExe)
		apps.POST("/:app_id/register", ah.Register)
		apps.POST("/:app_id/launch", ah.Launch)
		apps.POST("/:app_id/stop", ah.Stop)
		apps.GET("/:app_id/status", ah.Status)
		apps.GET("/:app_id/logs", ah.Logs)
	}

	// Component management
	if s.CompManager != nil {
		ch := handlers.NewComponentHandler(s.CompManager)
		comp := authed.Group("/components")
		comp.GET("", ch.List)
		comp.GET("/:name", ch.Get)
		comp.POST("/:name/start", ch.Start)
		comp.POST("/:name/stop", ch.Stop)
		comp.POST("/:name/restart", ch.Restart)
		comp.GET("/:name/logs", ch.Logs)
		comp.POST("/start-all", ch.StartAll)
		comp.POST("/stop-all", ch.StopAll)
	}
	if s.SessionMgr != nil {
		sh := handlers.NewSessionHandler(s.SessionMgr, []byte(s.Config.Server.MediaTicketSecret))
		if s.AppManager != nil {
			sh.EnsureViewingSession = s.AppManager.EnsureViewingSession
		}
		if s.MediaControl != nil {
			sh.SyncMedia = s.MediaControl.Sync
			sh.ValidateAudioTarget = s.MediaControl.ValidateAudioTarget
			authed.GET("/media-control", func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"status": "ok", "data": s.MediaControl.Status()})
			})
		}
		clientHandler := handlers.NewClientSessionHandler(sh, jwtSecret)
		clientHandler.GatewayPublicURL = s.Config.MoonlightWeb.PublicURL
		authed.POST("/stream-invitations", clientHandler.Invite)
		api.POST("/client-sessions/join", clientHandler.Join)
		api.POST("/client-sessions/:session_id/connections/:connection_id/resume", clientHandler.Resume)
		clients := api.Group("/client-sessions/:session_id/connections/:connection_id", clientHandler.Authorize())
		clients.GET("", clientHandler.Current)
		clients.POST("/heartbeat", clientHandler.Heartbeat)
		clients.POST("/ticket", sh.MediaTicket)
		clients.DELETE("", sh.Disconnect)
		sessions := authed.Group("/stream-sessions")
		sessions.GET("", sh.List)
		sessions.POST("", sh.Ensure)
		sessions.GET("/:session_id", sh.Get)
		sessions.POST("/:session_id/connections", sh.Connect)
		sessions.DELETE("/:session_id/connections/:connection_id", sh.Disconnect)
		sessions.POST("/:session_id/connections/:connection_id/heartbeat", sh.Heartbeat)
		sessions.POST("/:session_id/connections/:connection_id/ticket", sh.MediaTicket)
		sessions.POST("/:session_id/controller/:connection_id", sh.Claim)
		sessions.PUT("/:session_id/controller/:connection_id", sh.Transfer)
		sessions.DELETE("/:session_id/controller", sh.Release)
		sessions.PATCH("/:session_id/audio", sh.Audio)
		sessions.PATCH("/:session_id/audio-target", sh.AudioTarget)
		sessions.PATCH("/:session_id/policy", sh.Policy)
	}
}

func (s *Server) setupSPA() {
	executable, _ := os.Executable()
	distDir := spaDirectory(config.BaseDir, executable)
	if distDir != "" {
		s.Engine.Use(spaMiddleware(distDir))
	} else {
		s.Logger.Warn("未找到管理页 index.html，跳过 SPA 服务", zap.String("config_directory", config.BaseDir))
	}
}

// Keep configuration-local overrides and development assets compatible, while
// allowing service configuration and installed program files to live separately.
func spaDirectory(baseDir, executable string) string {
	candidates := []string{filepath.Join(baseDir, "dist"), filepath.Join(baseDir, "web", "dist")}
	if executable != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), "dist"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	return ""
}

func spaMiddleware(distDir string) gin.HandlerFunc {
	fileServer := http.FileServer(http.Dir(distDir))

	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// Skip API routes and WebSocket
		if strings.HasPrefix(path, "/api/") {
			c.Next()
			return
		}

		// Try to serve static file
		fullPath := filepath.Join(distDir, filepath.Clean(path))
		if info, err := os.Stat(fullPath); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(c.Writer, c.Request)
			c.Abort()
			return
		}

		// Check for directory with index.html
		if info, err := fs.Stat(os.DirFS(distDir), strings.TrimPrefix(path, "/")); err == nil && info.IsDir() {
			indexPath := filepath.Join(fullPath, "index.html")
			if _, err := os.Stat(indexPath); err == nil {
				fileServer.ServeHTTP(c.Writer, c.Request)
				c.Abort()
				return
			}
		}

		// SPA fallback: serve index.html
		c.File(filepath.Join(distDir, "index.html"))
		c.Abort()
	}
}

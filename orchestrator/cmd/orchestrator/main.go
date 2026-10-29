package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/moonlight"
	"github.com/stream-kit/orchestrator/internal/server"
	"github.com/stream-kit/orchestrator/internal/server/handlers"
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"github.com/stream-kit/orchestrator/internal/util"
	"github.com/stream-kit/orchestrator/internal/ws"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"
)

var (
	version   = "dev"
	commit    = "unknown"
	buildTime = "unknown"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version":
			fmt.Printf("stream-kit orchestrator %s (commit: %s, built: %s)\n", version, commit, buildTime)
			os.Exit(0)
		case "print-config":
			printConfig()
			os.Exit(0)
		}
	}

	handlers.Version = version
	handlers.Commit = commit
	handlers.BuildTime = buildTime

	configPath := "config.json"
	for i, arg := range os.Args {
		if arg == "--config" && i+1 < len(os.Args) {
			configPath = os.Args[i+1]
		}
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		fatalWithPause("配置加载失败: %v", err)
	}

	logger := setupLogger(cfg)
	defer logger.Sync()

	logger.Info("启动 Stream-Kit Orchestrator",
		zap.String("version", version),
		zap.String("bind_address", cfg.Server.BindAddress),
	)

	if cfg.Server.Username == "admin" && cfg.Server.Password == "admin" {
		logger.Warn("正在使用默认用户名密码（admin/admin），请尽快在 config.json 中修改！")
	}

	// Single instance check: try to listen on the port early
	// If another instance is running, the port will be occupied
	// (actual server starts later, this is just a pre-check)
	testListener, err := net.Listen("tcp", cfg.Server.BindAddress)
	if err != nil {
		fatalWithPause("端口 %s 已被占用，可能另一个实例正在运行: %v", cfg.Server.BindAddress, err)
	}
	testListener.Close()

	// Ensure directories
	for _, dir := range []string{cfg.Storage.AppsDir, cfg.Storage.TempDir, filepath.Dir(cfg.Storage.DBPath)} {
		os.MkdirAll(dir, 0755)
	}

	// Database
	st, err := store.New(cfg.Storage.DBPath)
	if err != nil {
		fatalWithPause("数据库初始化失败: %v", err)
	}
	defer st.Close()

	// Startup recovery: mark stale uploading/extracting apps as error
	recoverStaleApps(st, logger)
	cleanTempDir(cfg.Storage.TempDir, logger)

	// WebSocket Hub
	wsHub := ws.NewHub(logger)
	sessionMgr := session.NewManager(wsHub)

	// Component Manager — with event callback wired to WebSocket
	shutdownTimeout := cfg.Process.GracefulShutdownTimeout
	if shutdownTimeout <= 0 {
		shutdownTimeout = 5
	}
	compMgr := component.NewManager(
		cfg.Components,
		shutdownTimeout,
		filepath.Dir(cfg.Storage.DBPath),
		func(name string, status component.Status) {
			wsHub.Broadcast(ws.Event{
				Type: "component_status",
				Data: map[string]any{"name": name, "status": status},
			})
		},
		logger,
	)
	defer compMgr.Shutdown()

	// Sunshine & Moonlight clients (nil if not configured)
	var sunClient *sunshine.Client
	if cfg.SunshineAPI.BaseURL != "" {
		sunClient = sunshine.NewClient(cfg.SunshineAPI, logger)
	} else {
		logger.Warn("sunshine_api.base_url 未配置，跳过 Sunshine 集成")
	}
	var moonClient *moonlight.Client
	if cfg.MoonlightWeb.BaseURL != "" {
		moonClient = moonlight.NewClient(cfg.MoonlightWeb, logger)
	}

	// App Manager — with event callback wired to WebSocket
	appMgr := app.NewManager(st, cfg, sunClient, moonClient,
		func(appID string, status model.AppStatus) {
			wsHub.Broadcast(ws.Event{
				Type: "app_status",
				Data: map[string]any{"app_id": appID, "status": string(status)},
			})
		},
		logger,
	)

	// HTTP server
	srv := server.New(cfg, st, compMgr, appMgr, wsHub, sessionMgr, logger)

	httpServer := &http.Server{
		Addr:    cfg.Server.BindAddress,
		Handler: srv.Engine,
	}

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)

	go func() {
		<-sigCh
		logger.Info("收到关闭信号，正在停止...")

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		httpServer.Shutdown(shutdownCtx)
	}()

	// Recover orphan child processes from previous unclean shutdown
	compMgr.RecoverOrphanProcesses()

	// Monitor streaming state (detects when apps start/stop via Sunshine)
	streamCtx, streamCancel := context.WithCancel(context.Background())
	defer streamCancel()
	util.SafeGo(logger, "session-lease-reaper", func() {
		sessionMgr.RunLeaseReaper(streamCtx, 5*time.Second)
	})
	util.SafeGo(logger, "stream-monitor", func() { appMgr.MonitorStreaming(streamCtx) })

	// Auto-start components in background
	util.SafeGo(logger, "auto-start", func() {
		time.Sleep(500 * time.Millisecond)
		compMgr.StartAll()
	})

	// Start HTTP server
	logger.Info("HTTP 服务启动", zap.String("address", cfg.Server.BindAddress))
	if cfg.Server.TLSCert != "" && cfg.Server.TLSKey != "" {
		err = httpServer.ListenAndServeTLS(cfg.Server.TLSCert, cfg.Server.TLSKey)
	} else {
		err = httpServer.ListenAndServe()
	}

	if err != nil && err != http.ErrServerClosed {
		fatalWithPause("HTTP 服务异常退出: %v", err)
	}

	logger.Info("Orchestrator 已停止")
}

// recoverStaleApps marks apps stuck in transient states as error on startup.
func recoverStaleApps(st *store.Store, logger *zap.Logger) {
	apps, err := st.ListApps()
	if err != nil {
		logger.Warn("启动恢复：查询应用列表失败", zap.Error(err))
		return
	}
	staleStates := map[model.AppStatus]bool{
		model.AppStatusUploading:   true,
		model.AppStatusExtracting:  true,
		model.AppStatusDetecting:   true,
		model.AppStatusRegistering: true,
	}
	for _, a := range apps {
		if staleStates[a.Status] {
			logger.Warn("启动恢复：标记异常应用",
				zap.String("app_id", a.ID),
				zap.String("name", a.Name),
				zap.String("old_status", string(a.Status)),
			)
			st.UpdateAppStatus(a.ID, model.AppStatusError, "上次运行中断，请重新操作")

			// Clean up partial extraction directories
			if a.AppDir != "" && (a.Status == model.AppStatusExtracting || a.Status == model.AppStatusUploading) {
				if err := os.RemoveAll(a.AppDir); err == nil {
					logger.Info("启动恢复：清理未完成的应用目录", zap.String("app_dir", a.AppDir))
				}
			}
		}
	}
}

func cleanTempDir(tempDir string, logger *zap.Logger) {
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		path := filepath.Join(tempDir, e.Name())
		if err := os.RemoveAll(path); err != nil {
			logger.Warn("清理临时文件失败", zap.String("path", path), zap.Error(err))
		}
	}
	if len(entries) > 0 {
		logger.Info("启动恢复：清理临时文件", zap.Int("count", len(entries)))
	}
}

func setupLogger(cfg *config.Config) *zap.Logger {
	level := zap.InfoLevel
	switch cfg.Log.Level {
	case "debug":
		level = zap.DebugLevel
	case "warn":
		level = zap.WarnLevel
	case "error":
		level = zap.ErrorLevel
	}

	encoderCfg := zap.NewProductionEncoderConfig()
	encoderCfg.TimeKey = "ts"
	encoderCfg.EncodeTime = zapcore.ISO8601TimeEncoder

	cores := []zapcore.Core{
		zapcore.NewCore(
			zapcore.NewJSONEncoder(encoderCfg),
			zapcore.AddSync(os.Stdout),
			level,
		),
	}

	if cfg.Log.File.Enabled && cfg.Log.File.Path != "" {
		os.MkdirAll(filepath.Dir(cfg.Log.File.Path), 0755)
		fileWriter := &lumberjack.Logger{
			Filename:   cfg.Log.File.Path,
			MaxSize:    cfg.Log.File.MaxSizeMB,
			MaxBackups: cfg.Log.File.MaxBackups,
			MaxAge:     cfg.Log.File.MaxAgeDays,
			Compress:   cfg.Log.File.Compress,
		}
		cores = append(cores, zapcore.NewCore(
			zapcore.NewJSONEncoder(encoderCfg),
			zapcore.AddSync(fileWriter),
			level,
		))
	}

	return zap.New(zapcore.NewTee(cores...), zap.AddCaller())
}

// fatalWithPause writes error to stderr, a crash log file, and waits for user input on Windows.
func fatalWithPause(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, msg)

	// Always write to a crash log next to the exe so even double-click users can find it
	logPath := "orchestrator-error.log"
	entry := fmt.Sprintf("[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		f.WriteString(entry)
		f.Close()
	}

	// Pause so Windows double-click users can read the error
	fmt.Println("\n按 Enter 键退出...")
	fmt.Scanln()
	os.Exit(1)
}

func printConfig() {
	configPath := "config.json"
	for i, arg := range os.Args {
		if arg == "--config" && i+1 < len(os.Args) {
			configPath = os.Args[i+1]
		}
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "配置加载失败: %v\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(cfg.Sanitized(), "", "  ")
	fmt.Println(string(data))
}

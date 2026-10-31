package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/stream-kit/orchestrator/internal/app"
	"github.com/stream-kit/orchestrator/internal/bundle"
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
	"runtime"
	"syscall"
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
		case "init-platform":
			if err := initializePlatform(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, "platform initialization failed:", err)
				os.Exit(1)
			}
			return
		case "service":
			if err := serviceCommand(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, "service operation failed:", err)
				os.Exit(1)
			}
			return
		case "init-config":
			path, err := configArgument(os.Args[2:])
			if err != nil {
				argumentError(err)
			}
			if err := config.Initialize(path); err != nil {
				fmt.Fprintln(os.Stderr, "configuration initialization failed:", err)
				os.Exit(1)
			}
			fmt.Println("Configuration created; retrieve administrator credentials from the protected configuration file. No services started.")
			return
		case "check-config":
			path, err := configArgument(os.Args[2:])
			if err != nil {
				argumentError(err)
			}
			if err := checkConfig(path); err != nil {
				fmt.Fprintln(os.Stderr, "configuration check failed:", err)
				os.Exit(1)
			}
			fmt.Println("Configuration and configured TLS key pair validated; no services started or files created")
			return
		case "verify-bundle":
			if len(os.Args) != 3 {
				fmt.Fprintln(os.Stderr, "usage: orchestrator verify-bundle DIRECTORY")
				os.Exit(1)
			}
			manifest, err := bundle.Verify(os.Args[2], runtime.GOOS, runtime.GOARCH)
			if err != nil {
				fmt.Fprintln(os.Stderr, "bundle verification failed:", err)
				os.Exit(1)
			}
			fmt.Printf("Verified control-plane bundle %s (%s), %d files; publisher signature not verified\n", manifest.Version, manifest.Commit, len(manifest.Files))
			return
		case "render-worker":
			if err := component.RunWorker(context.Background(), os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, "render worker failed:", err)
				os.Exit(1)
			}
			return
		case "version":
			if len(os.Args) != 2 {
				argumentError(fmt.Errorf("%s", commandUsage))
			}
			fmt.Printf("stream-kit orchestrator %s (commit: %s, built: %s)\n", version, commit, buildTime)
			os.Exit(0)
		case "print-config":
			printConfig()
			os.Exit(0)
		case "help", "--help", "-h":
			if len(os.Args) != 2 {
				argumentError(fmt.Errorf("%s", commandUsage))
			}
			fmt.Println(commandUsage)
			return
		}
	}

	if _, err := configArgument(os.Args[1:]); err != nil {
		argumentError(err)
	}
	if err := runPlatform(run); err != nil {
		fatalError("%v", err)
	}
}

func runConsole(run func(context.Context, func()) error) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return run(ctx, func() {})
}

func run(ctx context.Context, ready func()) error {
	handlers.Version = version
	handlers.Commit = commit
	handlers.BuildTime = buildTime

	configPath, err := configArgument(os.Args[1:])
	if err != nil {
		return err
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("配置加载失败: %v", err)
	}
	tlsConfig, err := serverTLS(cfg.Server)
	if err != nil {
		return err
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

	// Own the listening socket for the full lifecycle; do not close and rebind.
	listener, err := net.Listen("tcp", cfg.Server.BindAddress)
	if err != nil {
		return fmt.Errorf("监听 %s 失败: %w", cfg.Server.BindAddress, err)
	}
	defer listener.Close()
	// Ensure directories
	for _, dir := range []string{cfg.Storage.AppsDir, cfg.Storage.TempDir, filepath.Dir(cfg.Storage.DBPath)} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("创建数据目录失败: %w", err)
		}
	}

	// Database
	st, err := store.New(cfg.Storage.DBPath)
	if err != nil {
		return fmt.Errorf("数据库初始化失败: %v", err)
	}
	defer st.Close()

	// WebSocket Hub
	wsHub := ws.NewHub(logger)
	defer wsHub.Close()
	sessionMgr, err := session.NewManagerWithStore(wsHub, st)
	if err != nil {
		return fmt.Errorf("加载渲染会话失败: %v", err)
	}

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
	var autoStartDone <-chan struct{}
	defer func() {
		// StartAll can be waiting on component readiness. Cancel the manager
		// before joining it, so shutdown does not wait for the startup timeout.
		compMgr.Shutdown()
		if autoStartDone != nil {
			<-autoStartDone
		}
	}()

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

	// Repair interrupted workflows before any request or background worker.
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(shutdownTimeout)*time.Second)
		defer cancel()
		if err := appMgr.Shutdown(ctx); err != nil {
			logger.Warn("等待上传处理退出超时", zap.Error(err))
		}
	}()
	if err := appMgr.RecoverInterruptedOperations(); err != nil {
		return fmt.Errorf("应用状态恢复失败: %v", err)
	}

	// HTTP server
	srv := server.New(cfg, st, compMgr, appMgr, wsHub, sessionMgr, logger)

	httpServer := &http.Server{
		Addr:      cfg.Server.BindAddress,
		Handler:   srv.Engine,
		TLSConfig: tlsConfig,
	}
	serveDone := make(chan struct{})
	httpShutdownDone := make(chan struct{})
	go func() {
		defer close(httpShutdownDone)
		select {
		case <-ctx.Done():
		case <-serveDone:
			return
		}
		logger.Info("收到关闭请求，正在停止...")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logger.Warn("HTTP 请求排空超时，关闭剩余连接", zap.Error(err))
			_ = httpServer.Close()
		}
	}()
	// Recover orphan child processes from previous unclean shutdown
	compMgr.RecoverOrphanProcesses()

	// Monitor streaming state (detects when apps start/stop via Sunshine)
	streamCtx, streamCancel := context.WithCancel(ctx)
	var background []<-chan struct{}
	defer func() {
		streamCancel()
		for _, done := range background {
			<-done
		}
	}()
	if srv.MediaControl != nil {
		background = append(background, util.SafeGo(logger, "media-state-reconciler", func() { srv.MediaControl.Run(streamCtx, logger) }))
		background = append(background, util.SafeGo(logger, "microphone-route-reconciler", func() { srv.MediaControl.RunRoutes(streamCtx, logger) }))
	}
	background = append(background, util.SafeGo(logger, "session-lease-reaper", func() {
		sessionMgr.RunLeaseReaper(streamCtx, 5*time.Second)
	}))
	background = append(background, util.SafeGo(logger, "stream-monitor", func() { appMgr.MonitorStreaming(streamCtx) }))

	// Auto-start components in background
	autoStartDone = util.SafeGo(logger, "auto-start", func() {
		select {
		case <-streamCtx.Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
		compMgr.StartAll()
	})

	if ctx.Err() != nil {
		close(serveDone)
		<-httpShutdownDone
		return nil
	}
	ready()
	// Start HTTP server
	logger.Info("HTTP 服务启动", zap.String("address", cfg.Server.BindAddress))
	if cfg.Server.TLSCert != "" && cfg.Server.TLSKey != "" {
		err = httpServer.ServeTLS(listener, "", "")
	} else {
		err = httpServer.Serve(listener)
	}

	close(serveDone)
	if err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("HTTP 服务异常退出: %v", err)
	}
	if err == http.ErrServerClosed {
		// Shutdown returns only after admitted HTTP handlers have drained (or
		// timed out); do not close their database while Shutdown is still running.
		<-httpShutdownDone
	}

	logger.Info("Orchestrator 已停止")
	return nil
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

// fatalError reports startup failure without blocking unattended service recovery.
func fatalError(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, msg)

	// Service working directories are not application-owned (often System32).
	// Prefer the configured data location, otherwise the installed binary folder.
	logDir := config.BaseDir
	if logDir == "" {
		if executable, err := os.Executable(); err == nil {
			logDir = filepath.Dir(executable)
		}
	}
	logPath := filepath.Join(logDir, "orchestrator-error.log")
	entry := fmt.Sprintf("[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		f.WriteString(entry)
		f.Close()
	}
	os.Exit(1)
}

func printConfig() {
	configPath, err := configArgument(os.Args[2:])
	if err != nil {
		argumentError(err)
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "配置加载失败: %v\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(cfg.Sanitized(), "", "  ")
	fmt.Println(string(data))
}

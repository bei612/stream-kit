package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/moonlight"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

type EventCallback func(appID string, status model.AppStatus)

type Manager struct {
	store          *store.Store
	config         *config.Config
	logger         *zap.Logger
	locks          sync.Map
	sunClient      *sunshine.Client
	moonClient     *moonlight.Client
	onEvent        EventCallback
	uploadMu       sync.Mutex   // global: only one upload/extract at a time
	uploading      atomic.Bool  // true when upload or extract is in progress
	lastLaunchedID atomic.Value // stores the appID (string) of the most recently launched app
}

func NewManager(st *store.Store, cfg *config.Config, sunClient *sunshine.Client, moonClient *moonlight.Client, onEvent EventCallback, logger *zap.Logger) *Manager {
	return &Manager{
		store:      st,
		config:     cfg,
		logger:     logger,
		sunClient:  sunClient,
		moonClient: moonClient,
		onEvent:    onEvent,
	}
}

// logIfErr logs a warning if err is non-nil. Used for non-fatal operations where
// we want visibility but don't want to abort the flow.
func (m *Manager) logIfErr(op string, err error) {
	if err != nil {
		m.logger.Warn("操作失败（非致命）", zap.String("op", op), zap.Error(err))
	}
}

// TryLockUpload attempts to acquire the global upload/extract lock.
// Only one upload+extract pipeline can run at a time.
func (m *Manager) TryLockUpload() (func(), error) {
	if !m.uploadMu.TryLock() {
		return nil, fmt.Errorf("当前有其他应用正在上传或解压中，请稍后再试")
	}
	m.uploading.Store(true)
	return func() {
		m.uploading.Store(false)
		m.uploadMu.Unlock()
	}, nil
}

// IsUploading returns true if an upload/extract is in progress.
func (m *Manager) IsUploading() bool {
	return m.uploading.Load()
}

// TryLock attempts to acquire a per-app lock. Returns unlock function or error if already locked.
func (m *Manager) TryLock(appID string) (func(), error) {
	val, _ := m.locks.LoadOrStore(appID, &sync.Mutex{})
	mu := val.(*sync.Mutex)
	if !mu.TryLock() {
		return nil, fmt.Errorf("应用正在执行其他操作")
	}
	return mu.Unlock, nil
}

func (m *Manager) updateStatus(appID string, status model.AppStatus, errMsg string) error {
	// Read current status for validation
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}
	if err := ValidateTransition(app.Status, status); err != nil {
		return err
	}
	// Compare-and-swap: atomically check current=app.Status then set to new status
	if err := m.store.TransitionAppStatus(appID, app.Status, status, errMsg); err != nil {
		return err
	}
	if m.onEvent != nil {
		go func() {
			defer func() { recover() }()
			m.onEvent(appID, status)
		}()
	}
	return nil
}

// CreateApp creates a new app record for an upload.
func (m *Manager) CreateApp(name, argsTemplate, args, exePath string, fileSize int64, captureMode model.CaptureMode) (*model.App, error) {
	if err := m.validateCaptureMode(captureMode); err != nil {
		return nil, err
	}
	// Check name uniqueness
	existing, err := m.store.GetAppByName(name)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, fmt.Errorf("同名应用已存在: %s", name)
	}

	id := uuid.New().String()
	appDir := filepath.Join(m.config.Storage.AppsDir, id)

	var tmpl *string
	if argsTemplate != "" {
		tmpl = &argsTemplate
		if templateArgs, ok := m.config.Templates[argsTemplate]; ok {
			args = templateArgs
		}
	}

	app := &model.App{
		CaptureMode:     captureMode.Normalized(),
		Source:          model.AppSourceArchive,
		ID:              id,
		Name:            name,
		Status:          model.AppStatusUploading,
		Args:            args,
		ArgsTemplate:    tmpl,
		AppDir:          appDir,
		ExeRelativePath: exePath,
		FileSizeBytes:   fileSize,
		SunshineAppName: name,
	}

	if err := m.store.CreateApp(app); err != nil {
		return nil, err
	}

	m.store.CreateLog("app", id, "upload", "success", fmt.Sprintf("应用 %s 开始上传", name), nil)
	return app, nil
}

// ProcessUploadComplete handles the post-upload pipeline: extract → detect → register.
// Runs in a goroutine. unlockUpload releases the global upload lock when pipeline finishes.
func (m *Manager) ProcessUploadComplete(appID, archivePath string, unlockUpload func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				m.logger.Error("上传处理 panic", zap.String("app_id", appID), zap.Any("panic", r))
			}
		}()
		unlock, err := m.TryLock(appID)
		if err != nil {
			unlockUpload()
			m.logger.Warn("pipeline 无法获取锁", zap.String("app_id", appID))
			return
		}
		defer unlock()
		m.runPipeline(appID, archivePath, unlockUpload)
	}()
}

func (m *Manager) runPipeline(appID, archivePath string, unlockUpload func()) {
	// This is the upload-owned temporary archive, including failure paths.
	defer os.Remove(archivePath)
	uploadLockReleased := false
	releaseUploadLock := func() {
		if !uploadLockReleased {
			uploadLockReleased = true
			unlockUpload()
		}
	}
	defer releaseUploadLock() // safety net: always release if not already

	if err := m.updateStatus(appID, model.AppStatusExtracting, ""); err != nil {
		m.logger.Error("状态更新失败", zap.Error(err))
		return
	}

	app, err := m.store.GetApp(appID)
	if err != nil || app == nil {
		m.logger.Error("获取应用记录失败", zap.String("app_id", appID), zap.Error(err))
		return
	}
	os.MkdirAll(app.AppDir, 0755)

	extractCfg := ExtractConfig{
		MaxExtractSize: m.config.Storage.MaxExtractSize,
		MaxFileCount:   m.config.Storage.MaxFileCount,
	}

	totalBytes, err := Extract(archivePath, app.AppDir, extractCfg)
	if err != nil {
		os.RemoveAll(app.AppDir)
		m.updateStatus(appID, model.AppStatusError, "解压失败: "+err.Error())
		m.store.CreateLog("app", appID, "extract", "failure", err.Error(), nil)
		return
	}

	m.logIfErr("update extracted size", m.store.UpdateAppFields(appID, map[string]interface{}{
		"extracted_size_bytes": totalBytes,
	}))
	m.store.CreateLog("app", appID, "extract", "success", fmt.Sprintf("解压完成，%d 字节", totalBytes), nil)

	// Release upload lock — extraction done, other uploads can proceed
	releaseUploadLock()

	// Step 2: Detect entry exe
	m.logIfErr("transition to detecting", m.updateStatus(appID, model.AppStatusDetecting, ""))

	if app.ExeRelativePath != "" {
		// User specified exe path
		if err := ValidateExePath(app.AppDir, app.ExeRelativePath); err != nil {
			m.updateStatus(appID, model.AppStatusError, "指定的入口文件无效: "+err.Error())
			return
		}
		exeFullPath := filepath.Join(app.AppDir, app.ExeRelativePath)
		m.store.UpdateAppFields(appID, map[string]interface{}{
			"exe_path":    exeFullPath,
			"working_dir": filepath.Dir(exeFullPath),
		})
	} else {
		// Auto-detect
		candidates, err := DetectEntryExe(app.AppDir)
		if err != nil {
			m.updateStatus(appID, model.AppStatusError, "入口检测失败: "+err.Error())
			return
		}

		if len(candidates) == 0 {
			m.updateStatus(appID, model.AppStatusError, "未找到可执行文件")
			return
		}

		if len(candidates) == 1 {
			m.store.UpdateAppFields(appID, map[string]interface{}{
				"exe_relative_path": candidates[0].RelativePath,
				"exe_path":          candidates[0].FullPath,
				"working_dir":       filepath.Dir(candidates[0].FullPath),
			})
		} else {
			// Multiple candidates - stay in detecting, wait for user to choose
			m.logger.Info("检测到多个入口候选",
				zap.String("app_id", appID),
				zap.Int("count", len(candidates)),
			)
			return // Stay in "detecting" status
		}
	}

	// Step 3: Register with Sunshine
	m.registerWithSunshine(appID)
}

func (m *Manager) registerWithSunshine(appID string) {
	app, err := m.store.GetApp(appID)
	if err != nil || app == nil {
		m.logger.Error("注册：获取应用失败", zap.String("app_id", appID), zap.Error(err))
		return
	}

	m.updateStatus(appID, model.AppStatusRegistering, "")

	if m.sunClient == nil {
		m.updateStatus(appID, model.AppStatusReady, "")
		m.store.CreateLog("app", appID, "register", "success", "Sunshine 未配置，跳过注册", nil)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Variable substitution in args
	args := app.Args
	args = strings.ReplaceAll(args, "{app_dir}", strings.ReplaceAll(programDirectory(app), "$", "$$"))
	args = strings.ReplaceAll(args, "{app_name}", app.Name)

	// Build command: exe path + args
	cmd := quoteProgram(app.ExePath)
	if args != "" {
		cmd = cmd + " " + args
	}

	// Generate default icon if none exists
	iconPath := filepath.Join(app.AppDir, "icon.png")
	if _, err := os.Stat(iconPath); os.IsNotExist(err) {
		iconPath = generateDefaultIcon(app.AppDir)
	}

	sunApp := sunshine.SunshineApp{
		CaptureMode: app.CaptureMode.Normalized(),
		Name:        app.SunshineAppName,
		Cmd:         cmd,
		WorkingDir:  strings.ReplaceAll(app.WorkingDir, "$", "$$"),
		Output:      strings.ReplaceAll(filepath.Join(app.AppDir, "output.log"), "$", "$$"),
		ImagePath:   iconPath,
		AutoDetach:  false,
		WaitAll:     true,
		ExitTimeout: 10,
		Elevated:    false,
	}

	// Find existing registration BEFORE creating new one
	existingIdx := -1
	if idx, err := m.sunClient.FindAppIndex(ctx, app.SunshineAppName); err == nil && idx >= 0 {
		existingIdx = idx
	}

	// Create new registration first (if create fails, old registration still exists)
	if err := m.sunClient.CreateApp(ctx, sunApp); err != nil {
		m.updateStatus(appID, model.AppStatusRegisterFailed, "编码器注册失败: "+err.Error())
		m.store.CreateLog("app", appID, "register", "failure", err.Error(), nil)
		m.logger.Warn("编码器注册失败", zap.String("app_id", appID), zap.Error(err))
		return
	}

	// Delete old registration AFTER new one succeeds (prevent duplicates)
	if existingIdx >= 0 {
		m.sunClient.DeleteApp(ctx, existingIdx)
		m.logger.Info("已删除编码器中的旧同名注册", zap.String("name", app.SunshineAppName))
	}

	// Try to get stream info from Moonlight-Web
	streamURL := ""
	if m.moonClient != nil {
		info, err := m.moonClient.FindStreamInfo(ctx, app.SunshineAppName)
		if err == nil {
			streamURL = info.Port + info.Path
		} else {
			m.logger.Warn("获取串流信息失败（不阻塞）", zap.Error(err))
		}
	}

	m.store.UpdateAppFields(appID, map[string]interface{}{
		"stream_url": streamURL,
	})
	m.updateStatus(appID, model.AppStatusReady, "")
	m.store.CreateLog("app", appID, "register", "success", "已注册到 Sunshine", nil)
	m.logger.Info("应用已注册到 Sunshine", zap.String("app_id", appID), zap.String("name", app.Name))
}

// RetryRegister re-attempts Sunshine registration for a register_failed app.
func (m *Manager) RetryRegister(appID string) error {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}
	if app.Status != model.AppStatusRegisterFailed {
		return fmt.Errorf("仅 register_failed 状态可重试注册，当前: %s", app.Status)
	}
	go func() {
		unlock, err := m.TryLock(appID)
		if err != nil {
			m.logger.Warn("重试注册无法获取锁", zap.String("app_id", appID))
			return
		}
		defer unlock()
		m.registerWithSunshine(appID)
	}()
	return nil
}

// (UnregisterFromSunshine logic is now inlined in DeleteApp for correct ordering)

// LaunchApp validates preconditions and returns the stream URL for the frontend to open.
// The actual streaming is initiated by Moonlight-Web when the user opens the URL.
func (m *Manager) LaunchApp(appID string) (string, error) {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return "", err
	}
	if err := m.validateCaptureMode(app.CaptureMode); err != nil {
		return "", err
	}
	if app.Source == model.AppSourceLocal {
		resolved, err := canonicalLocalPath(app.ExePath, false)
		if err != nil {
			return "", err
		}
		if resolved != app.ExePath {
			return "", fmt.Errorf("本机程序入口已改变，请重新注册")
		}
		if _, err = canonicalLocalPath(app.WorkingDir, true); err != nil {
			return "", err
		}
	}

	// Idempotent: if already running, return existing stream_url
	if app.Status == model.AppStatusRunning {
		if app.StreamURL != "" {
			return app.StreamURL, nil
		}
	}

	// Only ready/stopped/crashed can launch
	if app.Status != model.AppStatusReady && app.Status != model.AppStatusStopped && app.Status != model.AppStatusCrashed {
		return "", fmt.Errorf("应用当前状态 %s，无法启动串流", app.Status)
	}

	// Check Sunshine is reachable and no other app is streaming
	if m.sunClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		info, err := m.sunClient.GetServerInfo(ctx)
		if err != nil {
			return "", fmt.Errorf("编码器离线，无法启动串流: %w", err)
		}
		if info.CurrentGame > 0 {
			return "", fmt.Errorf("已有应用正在串流中，请先停止当前串流")
		}
	}

	// Get stream info from Moonlight-Web
	if m.moonClient == nil {
		return "", fmt.Errorf("串流网关未配置")
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	streamInfo, err := m.moonClient.FindStreamInfo(ctx2, app.SunshineAppName)
	if err != nil {
		return "", fmt.Errorf("串流网关离线或应用未注册: %w", err)
	}

	// Return the path+port info as JSON string for frontend to construct full URL
	streamURL := streamInfo.Port + streamInfo.Path
	m.logIfErr("save stream info", m.store.UpdateAppFields(appID, map[string]interface{}{"stream_url": streamURL}))

	// Record which app was launched so MonitorStreaming knows which to mark running
	m.lastLaunchedID.Store(appID)

	m.store.CreateLog("app", appID, "launch", "success", "已打开串流页面", nil)
	m.logger.Info("应用串流页面已打开", zap.String("app_id", appID), zap.String("name", app.Name))

	return streamURL, nil
}

// StopApp terminates streaming via the encoder API and waits for confirmation.
func (m *Manager) StopApp(appID string) error {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}

	// Idempotent: if not running, nothing to do
	if app.Status != model.AppStatusRunning {
		return nil
	}

	// Close via Sunshine
	if m.sunClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.sunClient.CloseApp(ctx); err != nil {
			m.logger.Warn("编码器关闭应用失败", zap.Error(err))
		}

		// Poll until currentgame == 0 (max 10s)
		deadline := time.After(10 * time.Second)
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
	pollLoop:
		for {
			select {
			case <-deadline:
				m.logger.Warn("等待串流停止超时", zap.String("app_id", appID))
				break pollLoop
			case <-ticker.C:
				info, err := m.sunClient.GetServerInfo(ctx)
				if err != nil || info.CurrentGame == 0 {
					break pollLoop
				}
			}
		}
	}

	m.updateStatus(appID, model.AppStatusStopped, "")
	m.store.CreateLog("app", appID, "stop", "success", "串流已停止", nil)
	m.logger.Info("应用串流停止", zap.String("app_id", appID), zap.String("name", app.Name))
	return nil
}

// MonitorStreaming runs a background loop that detects streaming state changes
// by polling Sunshine's serverinfo. It auto-transitions apps between running/stopped/crashed.
func (m *Manager) MonitorStreaming(ctx context.Context) {
	if m.sunClient == nil {
		return
	}

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	wasStreaming := false

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			info, err := m.sunClient.GetServerInfo(checkCtx)
			cancel()

			if err != nil {
				continue // Sunshine unreachable, skip this cycle
			}

			isStreaming := info.CurrentGame > 0

			if isStreaming && !wasStreaming {
				// Streaming just started — mark the last launched app as running
				if id, ok := m.lastLaunchedID.Load().(string); ok && id != "" {
					app, err := m.store.GetApp(id)
					if err == nil && (app.Status == model.AppStatusReady || app.Status == model.AppStatusStopped || app.Status == model.AppStatusCrashed) {
						m.updateStatus(id, model.AppStatusRunning, "")
						m.store.CreateLog("app", id, "stream_start", "success", "检测到串流已启动", nil)
						m.logger.Info("检测到串流启动", zap.String("app_id", id), zap.String("name", app.Name))
					}
				}
			}

			if !isStreaming && wasStreaming {
				// Streaming just stopped — find the running app and mark it
				apps, err := m.store.ListApps()
				if err == nil {
					for _, a := range apps {
						if a.Status == model.AppStatusRunning {
							m.updateStatus(a.ID, model.AppStatusStopped, "")
							m.store.CreateLog("app", a.ID, "stream_end", "success", "串流已结束", nil)
							m.logger.Info("检测到串流结束", zap.String("app_id", a.ID), zap.String("name", a.Name))
						}
					}
				}
			}

			wasStreaming = isStreaming
		}
	}
}

// ReadLogs reads the tail of an app's output.log file.
func (m *Manager) ReadLogs(appID string, lines int) ([]string, error) {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return nil, err
	}

	logPath := filepath.Join(app.AppDir, "output.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		return []string{}, nil // file doesn't exist yet, return empty
	}

	allLines := strings.Split(strings.TrimRight(string(data), "\n\r"), "\n")
	if len(allLines) > lines {
		allLines = allLines[len(allLines)-lines:]
	}
	return allLines, nil
}

// SelectExe manually selects an entry exe for an app in "detecting" state.
func (m *Manager) SelectExe(appID, exeRelPath string) error {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}
	if app.Status != model.AppStatusDetecting {
		return fmt.Errorf("应用当前状态 %s，仅 detecting 状态可选择入口", app.Status)
	}
	if app.Source == model.AppSourceLocal {
		return fmt.Errorf("本机程序入口已明确指定")
	}

	if err := ValidateExePath(app.AppDir, exeRelPath); err != nil {
		return err
	}

	exeFullPath := filepath.Join(app.AppDir, exeRelPath)
	m.store.UpdateAppFields(appID, map[string]interface{}{
		"exe_relative_path": exeRelPath,
		"exe_path":          exeFullPath,
		"working_dir":       filepath.Dir(exeFullPath),
	})

	m.store.CreateLog("app", appID, "extract", "success", "入口已选择: "+exeRelPath, nil)

	// Register with Sunshine directly (caller already holds per-app lock)
	m.registerWithSunshine(appID)
	return nil
}

// GetCandidates returns exe candidates for an app.
func (m *Manager) GetCandidates(appID string) ([]ExeCandidate, error) {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return nil, err
	}
	if app.Source == model.AppSourceLocal {
		return []ExeCandidate{}, nil
	}
	return DetectEntryExe(app.AppDir)
}

// DeleteApp removes the registration and its platform-owned files only.
// Local executable and working-directory references are never cleanup targets.
// Order: DB first (authoritative), then best-effort Sunshine unregister + file cleanup.
// Rationale: orphaned files are recoverable; orphaned DB records pointing to missing files are not.
func (m *Manager) DeleteApp(appID string) error {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}

	appName := app.SunshineAppName
	appDir, err := m.ownedDirectory(app)
	if err != nil {
		return err
	}

	// Pre-condition: stop streaming if running (inline, not via StopApp to avoid lock re-entry)
	if app.Status == model.AppStatusRunning && m.sunClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		m.sunClient.CloseApp(ctx)
		// Wait for streaming to stop
		deadline := time.After(10 * time.Second)
		ticker := time.NewTicker(1 * time.Second)
	stopWait:
		for {
			select {
			case <-deadline:
				m.logger.Warn("删除前等待串流停止超时", zap.String("app_id", appID))
				break stopWait
			case <-ticker.C:
				info, err := m.sunClient.GetServerInfo(ctx)
				if err != nil || info.CurrentGame == 0 {
					break stopWait
				}
			}
		}
		ticker.Stop()
		cancel()
	}

	// Step 1: Delete DB record (authoritative state)
	if err := m.store.DeleteApp(appID); err != nil {
		return err
	}

	m.store.CreateLog("app", appID, "delete", "success", fmt.Sprintf("应用 %s 已删除", app.Name), nil)

	// Step 2: Best-effort Sunshine unregister (uses saved name, not DB)
	if m.sunClient != nil && appName != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		idx, err := m.sunClient.FindAppIndex(ctx, appName)
		if err == nil && idx >= 0 {
			m.sunClient.DeleteApp(ctx, idx)
		}
	}

	// Step 3: Best-effort file cleanup (with retry for Windows Defender)
	if appDir != "" {
		for i := 0; i < 3; i++ {
			if err := os.RemoveAll(appDir); err == nil {
				break
			}
			if i < 2 {
				sleepSeconds(2)
			}
		}
	}

	return nil
}

// sleepSeconds is a simple blocking sleep helper used in retry loops.
func sleepSeconds(seconds int) {
	time.Sleep(time.Duration(seconds) * time.Second)
}

// UpdateApp updates app configuration. Pointer fields: nil=no change, non-nil=set value.
// If args or name change, Sunshine registration is automatically synced.
func (m *Manager) UpdateApp(appID string, name, args, argsTemplate *string, captureMode *model.CaptureMode) error {
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}

	// Reject changes while streaming (Sunshine can't hot-swap command line)
	if app.Status == model.AppStatusRunning {
		return fmt.Errorf("请先停止串流再修改参数")
	}

	fields := map[string]interface{}{}
	oldName := app.SunshineAppName
	needsReRegister := false
	if captureMode != nil {
		if *captureMode == "" {
			return fmt.Errorf("采集模式不能为空")
		}
		if err := m.validateCaptureMode(*captureMode); err != nil {
			return err
		}
		if *captureMode != app.CaptureMode.Normalized() {
			fields["capture_mode"] = *captureMode
			needsReRegister = true
		}
	}

	if name != nil && *name != app.Name {
		existing, _ := m.store.GetAppByName(*name)
		if existing != nil && existing.ID != appID {
			return fmt.Errorf("同名应用已存在: %s", *name)
		}
		fields["name"] = *name
		fields["sunshine_app_name"] = *name
		needsReRegister = true
	}

	if args != nil && *args != app.Args {
		fields["args"] = *args
		needsReRegister = true
	}

	if argsTemplate != nil {
		fields["args_template"] = *argsTemplate
		if templateArgs, ok := m.config.Templates[*argsTemplate]; ok {
			fields["args"] = templateArgs
			needsReRegister = true
		}
	}

	if len(fields) == 0 {
		return nil
	}

	if err := m.store.UpdateAppFields(appID, fields); err != nil {
		return err
	}

	// Re-register with Sunshine if args/name changed and app is in a registered state
	registeredStates := map[model.AppStatus]bool{
		model.AppStatusReady:   true,
		model.AppStatusStopped: true,
		model.AppStatusCrashed: true,
	}
	if needsReRegister && registeredStates[app.Status] && m.sunClient != nil {
		m.reRegisterSunshine(appID, oldName)
	}

	return nil
}

// reRegisterSunshine deletes the old Sunshine registration and creates a new one.
func (m *Manager) reRegisterSunshine(appID, oldName string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Delete old registration
	if oldName != "" {
		idx, err := m.sunClient.FindAppIndex(ctx, oldName)
		if err == nil && idx >= 0 {
			m.sunClient.DeleteApp(ctx, idx)
		}
	}

	// Re-register with updated data
	m.registerWithSunshine(appID)
}

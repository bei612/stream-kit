package app

import (
	"context"
	"errors"
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
	"github.com/stream-kit/orchestrator/internal/session"
	"github.com/stream-kit/orchestrator/internal/store"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

type EventCallback func(appID string, status model.AppStatus)

var ErrOperationConflict = errors.New("应用正在执行其他操作")

type Manager struct {
	store      *store.Store
	config     *config.Config
	logger     *zap.Logger
	locks      sync.Map
	sunClient  *sunshine.Client
	moonClient *moonlight.Client
	onEvent    EventCallback
	uploadMu   sync.Mutex  // global: only one upload/extract at a time
	uploading  atomic.Bool // true when upload or extract is in progress
	runtimeMu  sync.Mutex  // serializes runtime observations with stop/delete acknowledgements
	sessions   *session.Manager
	syncMedia  func(context.Context) error
	workMu     sync.Mutex
	closing    bool
	workCtx    context.Context
	cancelWork context.CancelFunc
	workers    sync.WaitGroup
	workDone   chan struct{}
}

func NewManager(st *store.Store, cfg *config.Config, sunClient *sunshine.Client, moonClient *moonlight.Client, onEvent EventCallback, logger *zap.Logger) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		workCtx: ctx, cancelWork: cancel, workDone: make(chan struct{}),
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
	m.workMu.Lock()
	defer m.workMu.Unlock()
	if m.closing {
		return nil, errors.New("服务正在停止，不能开始上传")
	}
	if !m.uploadMu.TryLock() {
		return nil, fmt.Errorf("当前有其他应用正在上传或解压中，请稍后再试")
	}
	m.uploading.Store(true)
	m.workers.Add(1) // Include admitted HTTP uploads, not only their later extraction.
	return func() {
		m.uploading.Store(false)
		m.uploadMu.Unlock()
		m.workers.Done()
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
		return nil, ErrOperationConflict
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
func (m *Manager) ProcessUploadComplete(appID string, archive *UploadArchive, unlockUpload func()) {
	m.workMu.Lock()
	if m.closing {
		m.workMu.Unlock()
		defer unlockUpload()
		m.logIfErr("cleanup rejected upload", archive.Cleanup())
		m.logIfErr("cancel upload status", m.updateStatus(appID, model.AppStatusError, "服务停止，上传处理已取消"))
		return
	}
	m.workers.Add(1)
	m.workMu.Unlock()
	go func() {
		defer m.workers.Done()
		defer func() { m.logIfErr("cleanup upload archive", archive.Cleanup()) }()
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
		m.runPipeline(appID, archive.Path, unlockUpload)
	}()
}

func (m *Manager) runPipeline(appID, archivePath string, unlockUpload func()) {
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

	totalBytes, err := ExtractContext(m.workCtx, archivePath, app.AppDir, extractCfg)
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
	if err := m.workCtx.Err(); err != nil {
		m.logIfErr("cancel registration status", m.updateStatus(appID, model.AppStatusError, "服务停止，注册已取消"))
		return
	}
	m.registerWithSunshine(appID)
}

func (m *Manager) registerWithSunshine(appID string) error {
	app, err := m.store.GetApp(appID)
	if err != nil || app == nil {
		m.logger.Error("注册：获取应用失败", zap.String("app_id", appID), zap.Error(err))
		return fmt.Errorf("获取待注册应用失败: %w", err)
	}

	if err := m.updateStatus(appID, model.AppStatusRegistering, ""); err != nil {
		return err
	}

	if m.sunClient == nil {
		if err := m.updateStatus(appID, model.AppStatusReady, ""); err != nil {
			return err
		}
		m.store.CreateLog("app", appID, "register", "success", "Sunshine 未配置，跳过注册", nil)
		return nil
	}

	ctx, cancel := context.WithTimeout(m.workCtx, 15*time.Second)
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

	registration, err := m.sunClient.UpsertManagedApp(ctx, app.ID, sunApp)
	if err != nil {
		m.updateStatus(appID, model.AppStatusRegisterFailed, "编码器注册失败: "+err.Error())
		m.store.CreateLog("app", appID, "register", "failure", err.Error(), nil)
		m.logger.Warn("编码器注册失败", zap.String("app_id", appID), zap.Error(err))
		return fmt.Errorf("编码器注册失败: %w", err)
	}

	// Try to get stream info from Moonlight-Web
	streamURL := ""
	if m.moonClient != nil {
		info, err := m.moonClient.FindStreamInfoByID(ctx, uint32(registration.GameStreamID))
		if err == nil {
			streamURL = info.Port + info.Path
		} else {
			m.logger.Warn("获取串流信息失败（不阻塞）", zap.Error(err))
		}
	}

	if err := m.store.UpdateAppFields(appID, map[string]interface{}{
		"stream_url":      streamURL,
		"sunshine_app_id": registration.GameStreamID,
	}); err != nil {
		m.updateStatus(appID, model.AppStatusRegisterFailed, "保存编码器应用身份失败: "+err.Error())
		return err
	}
	if err := m.updateStatus(appID, model.AppStatusReady, ""); err != nil {
		return err
	}
	m.store.CreateLog("app", appID, "register", "success", "已注册到 Sunshine", nil)
	m.logger.Info("应用已注册到 Sunshine", zap.String("app_id", appID), zap.String("name", app.Name))
	return nil
}

// RetryRegister re-attempts Sunshine registration for a register_failed app.
func (m *Manager) RetryRegister(appID string) error {
	unlock, err := m.TryLock(appID)
	if err != nil {
		return err
	}
	app, err := m.store.GetApp(appID)
	if err != nil {
		unlock()
		return err
	}
	if app.Status != model.AppStatusRegisterFailed {
		unlock()
		return fmt.Errorf("仅 register_failed 状态可重试注册，当前: %s", app.Status)
	}
	go func() {
		defer unlock()
		m.registerWithSunshine(appID)
	}()
	return nil
}

// LaunchApp validates preconditions and returns the stream URL for the frontend to open.
// The actual streaming is initiated by Moonlight-Web when the user opens the URL.
func (m *Manager) LaunchApp(appID string) (string, error) {
	unlock, err := m.TryLock(appID)
	if err != nil {
		return "", err
	}
	defer unlock()
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

	// Cached running state and URLs are not ownership evidence. A repeated open
	// still verifies the actual encoder identity before returning a stream URL.
	if app.Status != model.AppStatusReady && app.Status != model.AppStatusStopped && app.Status != model.AppStatusCrashed && app.Status != model.AppStatusRunning {
		return "", fmt.Errorf("应用当前状态 %s，无法启动串流", app.Status)
	}

	// Check Sunshine is reachable and no other app is streaming
	if m.sunClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		info, err := m.sunClient.Runtime(ctx)
		if err != nil {
			return "", fmt.Errorf("编码器离线，无法启动串流: %w", err)
		}
		if info.GameStreamID > 0 && (info.AppID != app.ID || info.GameStreamID != app.SunshineAppID) {
			return "", fmt.Errorf("已有应用正在串流中，请先停止当前串流")
		}
	}

	// Get stream info from Moonlight-Web
	if m.moonClient == nil {
		return "", fmt.Errorf("串流网关未配置")
	}
	if app.SunshineAppID <= 0 {
		m.registerWithSunshine(appID)
		app, err = m.store.GetApp(appID)
		if err != nil {
			return "", err
		}
		if app.Status != model.AppStatusReady || app.SunshineAppID <= 0 {
			return "", fmt.Errorf("应用身份注册未完成: %s", app.ErrorMessage)
		}
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	if m.sunClient == nil {
		return "", fmt.Errorf("编码器未配置，无法确认应用归属")
	}
	registered, err := m.sunClient.GetManagedApp(ctx2, app.ID)
	if err != nil {
		return "", fmt.Errorf("无法确认编码器应用归属: %w", err)
	}
	if registered.GameStreamID != app.SunshineAppID {
		return "", fmt.Errorf("编码器应用身份与本地记录不一致，请重新注册")
	}
	streamInfo, err := m.moonClient.FindStreamInfoByID(ctx2, uint32(app.SunshineAppID))
	if err != nil {
		return "", fmt.Errorf("串流网关离线或应用未注册: %w", err)
	}

	// Return the path+port info as JSON string for frontend to construct full URL
	streamURL := streamInfo.Port + streamInfo.Path
	m.logIfErr("save stream info", m.store.UpdateAppFields(appID, map[string]interface{}{"stream_url": streamURL}))

	m.store.CreateLog("app", appID, "launch", "success", "已打开串流页面", nil)
	m.logger.Info("应用串流页面已打开", zap.String("app_id", appID), zap.String("name", app.Name))

	return streamURL, nil
}

// StopApp terminates streaming via the encoder API and waits for confirmation.
func (m *Manager) StopApp(appID string) error {
	m.runtimeMu.Lock()
	defer m.runtimeMu.Unlock()
	unlock, err := m.TryLock(appID)
	if err != nil {
		return err
	}
	defer unlock()
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}

	if err := m.stopManagedExecution(app); err != nil {
		return err
	}
	if app.Status == model.AppStatusRunning || app.Status == model.AppStatusReady || app.Status == model.AppStatusCrashed {
		if err := m.updateStatus(appID, model.AppStatusStopped, ""); err != nil {
			return err
		}
	}
	m.store.CreateLog("app", appID, "stop", "success", "串流已停止", nil)
	m.logger.Info("应用串流停止", zap.String("app_id", appID), zap.String("name", app.Name))
	return nil
}

// stopExecution confirms ownership regardless of cached status. A different
// owner's execution is left untouched, and uncertain responses remain errors.
func (m *Manager) stopExecution(app *model.App) error {
	if m.sunClient == nil {
		if app.SunshineAppID > 0 || app.Status == model.AppStatusRunning {
			return fmt.Errorf("编码器未配置，无法确认应用已停止")
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	active, err := m.sunClient.Runtime(ctx)
	if err != nil {
		return fmt.Errorf("无法确认编码器运行状态: %w", err)
	}
	if active.GameStreamID == 0 || active.AppID != app.ID {
		return nil
	}
	if err := m.sunClient.StopManagedApp(ctx, app.ID, active.InstanceID); err != nil {
		return fmt.Errorf("指定应用实例停止未获确认: %w", err)
	}
	return nil
}

// MonitorStreaming runs a background loop that detects streaming state changes
// by polling the encoder's owned runtime identity, including after control restart.
func (m *Manager) MonitorStreaming(ctx context.Context) {
	if m.sunClient == nil {
		return
	}

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.runtimeMu.Lock()
			checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			info, err := m.sunClient.Runtime(checkCtx)
			cancel()
			if err == nil {
				m.reconcileStreaming(info)
			}
			m.runtimeMu.Unlock()
		}
	}
}

// reconcileStreaming uses persisted encoder identity, including after a control
// process restart or an app-to-app transition without an intervening idle poll.
func (m *Manager) reconcileStreaming(active sunshine.Runtime) {
	apps, err := m.store.ListApps()
	if err != nil {
		m.logger.Warn("读取应用状态失败", zap.Error(err))
		return
	}
	for _, app := range apps {
		matches := active.GameStreamID > 0 && app.SunshineAppID == active.GameStreamID && app.ID == active.AppID
		if matches && (app.Status == model.AppStatusReady || app.Status == model.AppStatusStopped || app.Status == model.AppStatusCrashed) {
			if err := m.updateStatus(app.ID, model.AppStatusRunning, ""); err != nil {
				continue
			}
			m.store.CreateLog("app", app.ID, "stream_start", "success", "编码器确认此应用正在运行", nil)
		} else if !matches && app.Status == model.AppStatusRunning {
			if err := m.updateStatus(app.ID, model.AppStatusStopped, ""); err != nil {
				continue
			}
			m.store.CreateLog("app", app.ID, "stream_end", "success", "编码器确认此应用已停止", nil)
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
	unlock, err := m.TryLock(appID)
	if err != nil {
		return err
	}
	defer unlock()
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
	if err := m.store.UpdateAppFields(appID, map[string]interface{}{
		"exe_relative_path": exeRelPath,
		"exe_path":          exeFullPath,
		"working_dir":       filepath.Dir(exeFullPath),
	}); err != nil {
		return err
	}

	m.store.CreateLog("app", appID, "extract", "success", "入口已选择: "+exeRelPath, nil)

	return m.registerWithSunshine(appID)
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
// Native unregister must acknowledge the UUID before records or owned files can
// be removed. A failed native operation leaves the local registration recoverable.
func (m *Manager) DeleteApp(appID string) error {
	m.runtimeMu.Lock()
	defer m.runtimeMu.Unlock()
	unlock, err := m.TryLock(appID)
	if err != nil {
		return err
	}
	defer unlock()
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}

	appDir, err := m.ownedDirectory(app)
	if err != nil {
		return err
	}

	if err := m.stopManagedExecution(app); err != nil {
		return fmt.Errorf("删除前无法确认应用已停止，已保留应用和文件: %w", err)
	}

	// Remove only the immutable native registration before deleting owned files.
	if m.sunClient != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := m.sunClient.DeleteManagedApp(ctx, app.ID)
		cancel()
		if err != nil {
			return fmt.Errorf("移除编码器应用注册失败，已保留应用和文件: %w", err)
		}
	}
	// Remove the local record only after native registration removal succeeds.
	if err := m.store.DeleteApp(appID); err != nil {
		return err
	}

	m.store.CreateLog("app", appID, "delete", "success", fmt.Sprintf("应用 %s 已删除", app.Name), nil)

	// Best-effort cleanup of owned files after both registration removals succeed.
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
	m.runtimeMu.Lock()
	defer m.runtimeMu.Unlock()
	unlock, err := m.TryLock(appID)
	if err != nil {
		return err
	}
	defer unlock()
	app, err := m.store.GetApp(appID)
	if err != nil {
		return err
	}

	// Restart-required settings must not race admission, stop or deletion. A
	// cached status is insufficient: a viewer may already be starting upstream.
	switch app.Status {
	case model.AppStatusReady, model.AppStatusStopped, model.AppStatusCrashed, model.AppStatusRegisterFailed:
	default:
		return fmt.Errorf("请等待应用处理完成并停止串流后再修改参数")
	}
	if m.sessions != nil {
		for _, s := range m.sessions.List() {
			if s.AppID == int64(app.SunshineAppID) && s.State != session.StateStopped {
				return fmt.Errorf("请先停止观看会话再修改参数")
			}
		}
	}
	if m.sunClient != nil && app.SunshineAppID > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		active, err := m.sunClient.Runtime(ctx)
		if err != nil {
			return fmt.Errorf("无法确认应用已停止，参数尚未修改: %w", err)
		}
		if active.AppID == app.ID || active.GameStreamID == app.SunshineAppID {
			return fmt.Errorf("请先停止编码器中的应用再修改参数")
		}
	}

	fields := map[string]interface{}{}
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
		model.AppStatusReady:          true,
		model.AppStatusStopped:        true,
		model.AppStatusCrashed:        true,
		model.AppStatusRegisterFailed: true,
	}
	if needsReRegister && registeredStates[app.Status] && m.sunClient != nil {
		if err := m.registerWithSunshine(appID); err != nil {
			return fmt.Errorf("参数已保存，但尚未确认编码器应用成功，请查看应用状态并重试注册: %w", err)
		}
	}

	return nil
}

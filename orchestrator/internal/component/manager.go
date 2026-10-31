package component

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/util"
	"go.uber.org/zap"
)

type Status string

const (
	StatusStopped   Status = "stopped"
	StatusStarting  Status = "starting"
	StatusRunning   Status = "running"
	StatusUnhealthy Status = "unhealthy"
	StatusCrashed   Status = "crashed"
	StatusError     Status = "error"
)

type ComponentState struct {
	Name       string    `json:"name"`
	Status     Status    `json:"status"`
	PID        int       `json:"pid"`
	StartedAt  time.Time `json:"started_at,omitempty"`
	CrashCount int       `json:"crash_count"`
	LastError  string    `json:"last_error,omitempty"`

	process       *ManagedProcess
	healthChecker *HealthChecker
	mu            sync.Mutex
	opMu          sync.Mutex // serializes lifecycle operations, including automatic restart
	generation    uint64
}

type EventCallback func(name string, status Status)

type Manager struct {
	components      map[string]*ComponentState
	configs         map[string]config.ComponentConfig
	shutdownTimeout int
	logger          *zap.Logger
	dataDir         string
	onEvent         EventCallback
	startStopMu     sync.Mutex // prevents concurrent StartAll/StopAll
	pidMu           sync.Mutex // serializes snapshots and writes across components
	closing         atomic.Bool
	ctx             context.Context
	cancel          context.CancelFunc
}

func NewManager(
	configs map[string]config.ComponentConfig,
	shutdownTimeout int,
	dataDir string,
	onEvent EventCallback,
	logger *zap.Logger,
) *Manager {
	if shutdownTimeout <= 0 {
		shutdownTimeout = 5
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		ctx:             ctx,
		cancel:          cancel,
		components:      make(map[string]*ComponentState),
		configs:         configs,
		shutdownTimeout: shutdownTimeout,
		logger:          logger,
		dataDir:         dataDir,
		onEvent:         onEvent,
	}
	for name := range configs {
		m.components[name] = &ComponentState{Name: name, Status: StatusStopped}
	}
	return m
}

// ComponentInfo is a snapshot of component state without mutex (safe to copy/serialize).
type ComponentInfo struct {
	Name       string    `json:"name"`
	Status     Status    `json:"status"`
	PID        int       `json:"pid"`
	StartedAt  time.Time `json:"started_at,omitempty"`
	CrashCount int       `json:"crash_count"`
	LastError  string    `json:"last_error,omitempty"`
}

func (m *Manager) GetAll() []ComponentInfo {
	result := make([]ComponentInfo, 0, len(m.components))
	for _, cs := range m.components {
		cs.mu.Lock()
		info := ComponentInfo{
			Name: cs.Name, Status: cs.Status, PID: cs.PID,
			StartedAt: cs.StartedAt, CrashCount: cs.CrashCount, LastError: cs.LastError,
		}
		cs.mu.Unlock()
		result = append(result, info)
	}
	return result
}

func (m *Manager) Get(name string) (*ComponentInfo, error) {
	cs, ok := m.components[name]
	if !ok {
		return nil, fmt.Errorf("component not found: %s", name)
	}
	cs.mu.Lock()
	info := &ComponentInfo{
		Name: cs.Name, Status: cs.Status, PID: cs.PID,
		StartedAt: cs.StartedAt, CrashCount: cs.CrashCount, LastError: cs.LastError,
	}
	cs.mu.Unlock()
	return info, nil
}

func (m *Manager) GetLogBuffer(name string) *RingBuffer {
	cs, ok := m.components[name]
	if !ok {
		return NewRingBuffer(10)
	}
	cs.mu.Lock()
	proc := cs.process
	cs.mu.Unlock()
	if proc != nil {
		return proc.LogBuf
	}
	return NewRingBuffer(10)
}

func (m *Manager) Start(name string) error {
	cs, ok := m.components[name]
	if !ok {
		return fmt.Errorf("组件 %s 不存在", name)
	}
	cs.opMu.Lock()
	defer cs.opMu.Unlock()
	return m.start(name, cs, false)
}

// start requires opMu. Automatic retries retain their crash budget.
func (m *Manager) start(name string, cs *ComponentState, retry bool) error {
	if m.closing.Load() {
		return fmt.Errorf("组件管理器正在关闭")
	}
	cfg := m.configs[name]

	cs.mu.Lock()
	if cs.process != nil || cs.Status == StatusRunning || cs.Status == StatusStarting || cs.Status == StatusUnhealthy {
		cs.mu.Unlock()
		return nil // idempotent
	}
	cs.mu.Unlock()
	if err := m.preflight(m.ctx, name); err != nil {
		cs.mu.Lock()
		cs.Status = StatusError
		cs.LastError = err.Error()
		cs.mu.Unlock()
		m.emitEvent(name, StatusError)
		return err
	}
	if m.closing.Load() {
		return fmt.Errorf("组件管理器正在关闭")
	}
	cs.mu.Lock()
	cs.Status = StatusStarting
	cs.LastError = ""
	if cs.healthChecker != nil {
		cs.healthChecker.Close()
		cs.healthChecker = nil
	}
	cs.generation++
	if !retry {
		cs.CrashCount = 0
	}
	cs.mu.Unlock()

	m.emitEvent(name, StatusStarting)

	// Monitor-only: exe_path 为空表示组件由外部管理
	if cfg.ExePath == "" {
		cs.mu.Lock()
		cs.healthChecker = NewHealthChecker(name, cfg.HealthCheck, m.logger)
		hc := cs.healthChecker
		cs.mu.Unlock()
		m.logger.Info("组件监控模式（外部管理）", zap.String("component", name))
		util.SafeGo(m.logger, "waitForStartup-"+name, func() { m.waitForStartup(name, cs, hc) })
		return nil
	}

	// The platform selects direct or interactive-session ownership.
	logBuf := NewRingBuffer(2000)
	proc, err := launchComponent(m.ctx, cfg, m.dataDir, logBuf, m.logger)
	if err != nil {
		cs.mu.Lock()
		cs.Status = StatusError
		cs.LastError = err.Error()
		cs.mu.Unlock()
		m.emitEvent(name, StatusError)
		m.logger.Error("组件启动失败", zap.String("component", name), zap.Error(err))
		return fmt.Errorf("启动失败: %w", err)
	}

	cs.mu.Lock()
	cs.process = proc
	cs.PID = proc.PID
	cs.StartedAt = time.Now()
	cs.healthChecker = NewHealthChecker(name, cfg.HealthCheck, m.logger)
	hc := cs.healthChecker
	cs.mu.Unlock()

	m.logger.Info("组件已启动", zap.String("component", name), zap.Int("pid", proc.PID))

	// Background goroutines — all with panic recovery
	util.SafeGo(m.logger, "waitForExit-"+name, func() { m.waitForExit(name, cs, proc, cfg) })
	util.SafeGo(m.logger, "waitForStartup-"+name, func() { m.waitForStartup(name, cs, hc) })

	m.savePIDs()
	return nil
}

func (m *Manager) Stop(name string) error {
	cs, ok := m.components[name]
	if !ok {
		return fmt.Errorf("组件 %s 不存在", name)
	}
	cs.opMu.Lock()
	defer cs.opMu.Unlock()
	return m.stop(name, cs)
}

// stop requires opMu and invalidates delayed restart and health callbacks.
func (m *Manager) stop(name string, cs *ComponentState) error {

	cs.mu.Lock()
	cs.generation++
	if cs.healthChecker != nil {
		cs.healthChecker.Close()
		cs.healthChecker = nil
	}
	if cs.Status == StatusStopped {
		cs.mu.Unlock()
		return nil // idempotent
	}
	proc := cs.process
	cs.mu.Unlock()

	if proc == nil {
		cs.mu.Lock()
		cs.Status = StatusStopped
		cs.PID = 0
		cs.mu.Unlock()
		m.emitEvent(name, StatusStopped)
		return nil
	}

	m.logger.Info("正在停止组件", zap.String("component", name), zap.Int("pid", proc.PID))
	proc.Stopping.Store(true)
	if err := stopProcess(proc, m.shutdownTimeout); err != nil {
		cs.mu.Lock()
		cs.Status = StatusError
		cs.LastError = err.Error()
		cs.mu.Unlock()
		m.emitEvent(name, StatusError)
		return err
	}

	cs.mu.Lock()
	cs.Status = StatusStopped
	cs.PID = 0
	cs.process = nil
	if cs.healthChecker != nil {
		cs.healthChecker.Close()
		cs.healthChecker = nil
	}
	cs.mu.Unlock()

	m.emitEvent(name, StatusStopped)
	m.savePIDs()
	m.logger.Info("组件已停止", zap.String("component", name))
	return nil
}

func (m *Manager) Restart(name string) error {
	cs, ok := m.components[name]
	if !ok {
		return fmt.Errorf("组件 %s 不存在", name)
	}
	cs.opMu.Lock()
	defer cs.opMu.Unlock()
	if err := m.preflight(m.ctx, name); err != nil {
		return err // leave the running component and its health checker untouched
	}
	if err := m.stop(name, cs); err != nil {
		return err
	}
	return m.start(name, cs, false)
}

func (m *Manager) preflight(ctx context.Context, name string) error {
	cfg := m.configs[name]
	if err := checkLaunchContext(name, cfg); err != nil {
		return err
	}
	return preflightComponent(ctx, cfg, m.dataDir)
}

func (m *Manager) StartAll() {
	// Start in config order: iterate all configured components
	for name, cfg := range m.configs {
		if m.closing.Load() {
			return
		}
		if !cfg.AutoStart {
			continue
		}
		if err := m.Start(name); err != nil {
			m.logger.Error("自动启动失败", zap.String("component", name), zap.Error(err))
			continue
		}
		m.waitUntilRunning(name, 60*time.Second)
	}
}

func (m *Manager) waitUntilRunning(name string, timeout time.Duration) {
	deadline := time.After(timeout)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-deadline:
			m.logger.Warn("等待组件就绪超时", zap.String("component", name))
			return
		case <-ticker.C:
			cs := m.components[name]
			cs.mu.Lock()
			s := cs.Status
			cs.mu.Unlock()
			if s == StatusRunning || s == StatusError || s == StatusStopped {
				return
			}
		}
	}
}

// StartAllAsync runs StartAll in a background goroutine. Returns false if already in progress.
func (m *Manager) StartAllAsync() bool {
	if m.closing.Load() {
		return false
	}
	if !m.startStopMu.TryLock() {
		return false
	}
	util.SafeGo(m.logger, "start-all", func() {
		defer m.startStopMu.Unlock()
		m.StartAll()
	})
	return true
}

// StopAllAsync runs StopAll in a background goroutine. Returns false if already in progress.
func (m *Manager) StopAllAsync() bool {
	if !m.startStopMu.TryLock() {
		return false
	}
	util.SafeGo(m.logger, "stop-all", func() {
		defer m.startStopMu.Unlock()
		m.StopAll()
	})
	return true
}

func (m *Manager) StopAll() {
	for name := range m.components {
		m.Stop(name)
	}
}

func (m *Manager) Shutdown() {
	m.closing.Store(true)
	m.cancel()
	m.StopAll()
}

// Background goroutines

// waitForExit is the ONLY place that calls proc.RunWait(). It closes proc.Done.
func (m *Manager) waitForExit(name string, cs *ComponentState, proc *ManagedProcess, cfg config.ComponentConfig) {
	proc.RunWait() // blocks until process exits, closes proc.Done

	cs.opMu.Lock()
	if proc.Stopping.Load() {
		cs.opMu.Unlock()
		return // intentional stop, handled by Stop()
	}

	exitCode := proc.ExitCode
	cs.mu.Lock()
	if cs.process != proc {
		cs.mu.Unlock()
		cs.opMu.Unlock()
		return
	}
	if cs.healthChecker != nil {
		cs.healthChecker.Close()
		cs.healthChecker = nil
	}
	generation := cs.generation
	cs.CrashCount++
	cs.LastError = fmt.Sprintf("进程退出，退出码: %d", exitCode)
	cs.PID = 0
	cs.process = nil
	crashCount := cs.CrashCount

	m.logger.Warn("组件崩溃", zap.String("component", name), zap.Int("exit_code", exitCode), zap.Int("crash_count", crashCount))

	if cfg.RestartOnCrash && crashCount <= cfg.MaxRestartAttempts {
		cs.Status = StatusCrashed
		cs.mu.Unlock()
		m.emitEvent(name, StatusCrashed)
		m.savePIDs()
		cs.opMu.Unlock()

		delay := cfg.RestartDelay
		if delay <= 0 {
			delay = 5
		}
		timer := time.NewTimer(time.Duration(delay) * time.Second)
		select {
		case <-m.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}

		cs.opMu.Lock()
		defer cs.opMu.Unlock()
		cs.mu.Lock()
		current := cs.generation == generation && cs.Status == StatusCrashed
		cs.mu.Unlock()
		if !current {
			return
		}
		if err := m.start(name, cs, true); err != nil {
			m.logger.Error("重启失败", zap.String("component", name), zap.Error(err))
		}
	} else {
		cs.Status = StatusError
		cs.mu.Unlock()
		m.emitEvent(name, StatusError)
		m.logger.Error("组件崩溃次数超限", zap.String("component", name))
		cs.opMu.Unlock()
	}
	m.savePIDs()
}

// healthTransition rejects callbacks from a previous component lifetime.
// Network requests never hold the lifecycle lock.
func (m *Manager) healthTransition(name string, cs *ComponentState, hc *HealthChecker, from, to Status, message string) bool {
	cs.opMu.Lock()
	defer cs.opMu.Unlock()
	cs.mu.Lock()
	if cs.healthChecker != hc || cs.Status != from {
		cs.mu.Unlock()
		return false
	}
	cs.Status = to
	cs.LastError = message
	cs.mu.Unlock()
	m.emitEvent(name, to)
	return true
}

func (m *Manager) waitForStartup(name string, cs *ComponentState, hc *HealthChecker) {
	deadline := time.NewTimer(hc.StartupTimeout())
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-hc.ctx.Done():
			return
		case <-deadline.C:
			m.healthTransition(name, cs, hc, StatusStarting, StatusError, "启动超时，健康检查未通过")
			return
		case <-ticker.C:
			if hc.Check() && m.healthTransition(name, cs, hc, StatusStarting, StatusRunning, "") {
				util.SafeGo(m.logger, "crashReset-"+name, func() {
					timer := time.NewTimer(60 * time.Second)
					defer timer.Stop()
					select {
					case <-hc.ctx.Done():
						return
					case <-timer.C:
						cs.mu.Lock()
						if cs.healthChecker == hc && cs.Status == StatusRunning {
							cs.CrashCount = 0
						}
						cs.mu.Unlock()
					}
				})
				m.runHealthCheck(name, cs, hc)
				return
			}
		}
	}
}

func (m *Manager) runHealthCheck(name string, cs *ComponentState, hc *HealthChecker) {
	ticker := time.NewTicker(hc.IntervalDuration())
	defer ticker.Stop()
	for {
		select {
		case <-hc.ctx.Done():
			return
		case <-ticker.C:
			hc.Check()
			if hc.IsUnhealthy() {
				m.healthTransition(name, cs, hc, StatusRunning, StatusUnhealthy, "")
			} else if hc.IsHealthy() {
				m.healthTransition(name, cs, hc, StatusUnhealthy, StatusRunning, "")
			}
		}
	}
}
func (m *Manager) emitEvent(name string, status Status) {
	if m.onEvent != nil {
		m.onEvent(name, status)
	}
}

// RecoverOrphanProcesses logs any orphaned PIDs from a previous run.
// Does NOT kill processes because PID reuse on Windows can cause innocent process termination.
// Components will fail to start if ports are still occupied, which is a safe signal.
func (m *Manager) RecoverOrphanProcesses() {
	path := filepath.Join(m.dataDir, "pids.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	os.Remove(path)

	var prev pidData
	if err := json.Unmarshal(data, &prev); err != nil {
		return
	}

	for name, pid := range prev.Components {
		if pid <= 0 {
			continue
		}
		if isProcessAlive(pid) {
			m.logger.Warn("检测到上次运行的残留进程（不自动终止，避免误杀）",
				zap.String("component", name), zap.Int("pid", pid))
		}
	}
}

// PID persistence

type pidData struct {
	Components map[string]int `json:"components"`
}

func (m *Manager) savePIDs() {
	m.pidMu.Lock()
	defer m.pidMu.Unlock()
	data := pidData{Components: make(map[string]int)}
	for name, cs := range m.components {
		cs.mu.Lock()
		data.Components[name] = cs.PID
		cs.mu.Unlock()
	}
	path := filepath.Join(m.dataDir, "pids.json")
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		m.logger.Warn("PID 序列化失败", zap.Error(err))
		return
	}
	if err := os.WriteFile(path, b, 0644); err != nil {
		m.logger.Warn("PID 文件写入失败", zap.Error(err))
	}
}

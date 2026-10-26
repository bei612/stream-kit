package component

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
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
	m := &Manager{
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
	cfg := m.configs[name]

	cs.mu.Lock()
	if cs.Status == StatusRunning || cs.Status == StatusStarting {
		cs.mu.Unlock()
		return nil // idempotent
	}
	cs.Status = StatusStarting
	cs.LastError = ""
	cs.mu.Unlock()

	m.emitEvent(name, StatusStarting)

	// Monitor-only: exe_path 为空表示组件由外部管理
	if cfg.ExePath == "" {
		cs.mu.Lock()
		cs.healthChecker = NewHealthChecker(name, cfg.HealthCheck, m.logger)
		cs.mu.Unlock()
		m.logger.Info("组件监控模式（外部管理）", zap.String("component", name))
		util.SafeGo(m.logger, "waitForStartup-"+name, func() { m.waitForStartup(name, cs) })
		return nil
	}

	// Direct process launch
	logBuf := NewRingBuffer(2000)
	proc, err := StartProcess(cfg.ExePath, cfg.Args, cfg.WorkingDir, cfg.Env, logBuf, m.logger)
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
	cs.CrashCount = 0
	cs.healthChecker = NewHealthChecker(name, cfg.HealthCheck, m.logger)
	cs.mu.Unlock()

	m.logger.Info("组件已启动", zap.String("component", name), zap.Int("pid", proc.PID))

	// Background goroutines — all with panic recovery
	util.SafeGo(m.logger, "waitForExit-"+name, func() { m.waitForExit(name, cs, proc, cfg) })
	util.SafeGo(m.logger, "waitForStartup-"+name, func() { m.waitForStartup(name, cs) })

	m.savePIDs()
	return nil
}

func (m *Manager) Stop(name string) error {
	cs, ok := m.components[name]
	if !ok {
		return fmt.Errorf("组件 %s 不存在", name)
	}

	cs.mu.Lock()
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
	stopProcess(proc, m.shutdownTimeout)

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
	if err := m.Stop(name); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	return m.Start(name)
}

func (m *Manager) StartAll() {
	// Start in config order: iterate all configured components
	for name, cfg := range m.configs {
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
	m.StopAll()
}

// Background goroutines

// waitForExit is the ONLY place that calls proc.RunWait(). It closes proc.Done.
func (m *Manager) waitForExit(name string, cs *ComponentState, proc *ManagedProcess, cfg config.ComponentConfig) {
	proc.RunWait() // blocks until process exits, closes proc.Done

	if proc.Stopping.Load() {
		return // intentional stop, handled by Stop()
	}

	exitCode := proc.ExitCode
	cs.mu.Lock()
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

		delay := cfg.RestartDelay
		if delay <= 0 {
			delay = 5
		}
		time.Sleep(time.Duration(delay) * time.Second)

		if err := m.Start(name); err != nil {
			m.logger.Error("重启失败", zap.String("component", name), zap.Error(err))
		}
	} else {
		cs.Status = StatusError
		cs.mu.Unlock()
		m.emitEvent(name, StatusError)
		m.logger.Error("组件崩溃次数超限", zap.String("component", name))
	}
	m.savePIDs()
}

func (m *Manager) waitForStartup(name string, cs *ComponentState) {
	cs.mu.Lock()
	hc := cs.healthChecker
	cs.mu.Unlock()

	if hc == nil {
		cs.mu.Lock()
		if cs.Status == StatusStarting {
			cs.Status = StatusRunning
		}
		cs.mu.Unlock()
		m.emitEvent(name, StatusRunning)
		// Start periodic health check
		util.SafeGo(m.logger, "healthCheck-"+name, func() { m.runHealthCheck(name, cs) })
		return
	}

	timeout := hc.StartupTimeout()
	deadline := time.After(timeout)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-deadline:
			cs.mu.Lock()
			if cs.Status == StatusStarting {
				cs.Status = StatusError
				cs.LastError = "启动超时，健康检查未通过"
			}
			cs.mu.Unlock()
			m.emitEvent(name, StatusError)
			return
		case <-ticker.C:
			cs.mu.Lock()
			if cs.Status != StatusStarting {
				cs.mu.Unlock()
				return // status changed externally
			}
			cs.mu.Unlock()

			if hc.Check() {
				cs.mu.Lock()
				if cs.Status == StatusStarting {
					cs.Status = StatusRunning
				}
				cs.mu.Unlock()
				m.emitEvent(name, StatusRunning)
				m.logger.Info("组件健康检查通过", zap.String("component", name))
				// Reset crash count after 60s stable run
				util.SafeGo(m.logger, "crashReset-"+name, func() {
					time.Sleep(60 * time.Second)
					cs.mu.Lock()
					if cs.Status == StatusRunning {
						cs.CrashCount = 0
					}
					cs.mu.Unlock()
				})
				// Start periodic health check
				util.SafeGo(m.logger, "healthCheck-"+name, func() { m.runHealthCheck(name, cs) })
				return
			}
		}
	}
}

func (m *Manager) runHealthCheck(name string, cs *ComponentState) {
	cs.mu.Lock()
	hc := cs.healthChecker
	cs.mu.Unlock()
	if hc == nil {
		return
	}

	ticker := time.NewTicker(hc.IntervalDuration())
	defer ticker.Stop()

	for range ticker.C {
		cs.mu.Lock()
		if cs.Status != StatusRunning && cs.Status != StatusUnhealthy {
			cs.mu.Unlock()
			return
		}
		cs.mu.Unlock()

		hc.Check()

		cs.mu.Lock()
		if hc.IsUnhealthy() && cs.Status == StatusRunning {
			cs.Status = StatusUnhealthy
			cs.mu.Unlock()
			m.emitEvent(name, StatusUnhealthy)
		} else if hc.IsHealthy() && cs.Status == StatusUnhealthy {
			cs.Status = StatusRunning
			cs.mu.Unlock()
			m.emitEvent(name, StatusRunning)
		} else {
			cs.mu.Unlock()
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

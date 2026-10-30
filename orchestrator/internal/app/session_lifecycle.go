package app

import (
	"context"
	"fmt"
	"time"

	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/session"
)

// ConfigureSessionLifecycle wires the existing session authority and signed
// media publisher before serving requests. It must not be changed at runtime.
func (m *Manager) ConfigureSessionLifecycle(sessions *session.Manager, syncMedia func(context.Context) error) {
	m.sessions, m.syncMedia = sessions, syncMedia
}

// stopManagedExecution orders admission revocation, gateway acknowledgement,
// native execution stop and session completion. No failure restores old viewers
// or reports a completed stop; the persisted stopping state can be retried.
func (m *Manager) stopManagedExecution(app *model.App) error {
	id, err := m.revokeViewingSession(app)
	if err != nil {
		return err
	}
	if err := m.stopExecution(app); err != nil {
		return err
	}
	if id != "" {
		if err := m.sessions.CompleteStop(id); err != nil {
			return fmt.Errorf("程序已停止，会话结束状态尚未提交，请重试: %w", err)
		}
	}
	return nil
}

func (m *Manager) revokeViewingSession(app *model.App) (string, error) {
	if m.sessions == nil || app.SunshineAppID <= 0 {
		return "", nil
	}
	// No current viewing generation means there are no old viewer capabilities
	// to revoke. A concurrent new administrator admission is a separate intent.
	needed := false
	for _, s := range m.sessions.List() {
		if s.AppID == int64(app.SunshineAppID) && s.State != session.StateStopped {
			needed = true
			break
		}
	}
	if !needed {
		return "", nil
	}
	if m.moonClient == nil || m.syncMedia == nil {
		return "", fmt.Errorf("媒体网关未配置，无法确认观看会话已撤销")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Host identity is authoritative gateway metadata, never an app name or a
	// cached URL. Ambiguous/missing catalogs cannot authorize another host's stop.
	target, err := m.moonClient.FindStreamInfoByID(ctx, uint32(app.SunshineAppID))
	if err != nil {
		return "", fmt.Errorf("无法确认观看会话所属主机: %w", err)
	}
	id, err := m.sessions.BeginStop(int64(target.HostID), int64(target.AppID))
	if err != nil {
		return "", fmt.Errorf("观看会话停止状态提交失败: %w", err)
	}
	if id == "" {
		return "", fmt.Errorf("观看会话与网关主机归属不一致，停止尚未执行")
	}
	if err := m.syncMedia(ctx); err != nil {
		return "", fmt.Errorf("观看会话已禁止接入，媒体网关撤销尚未确认，请重试: %w", err)
	}
	return id, nil
}

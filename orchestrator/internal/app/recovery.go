package app

import (
	"fmt"

	"github.com/stream-kit/orchestrator/internal/model"
)

// RecoverInterruptedOperations runs before serving requests or starting workers.
// It repairs workflow state only. Native ownership still requires an encoder
// acknowledgement; startup must not delete files or infer that execution stopped.
func (m *Manager) RecoverInterruptedOperations() error {
	apps, err := m.store.ListApps()
	if err != nil {
		return fmt.Errorf("读取待恢复应用失败: %w", err)
	}
	for _, record := range apps {
		var next model.AppStatus
		var reason string
		switch record.Status {
		case model.AppStatusUploading, model.AppStatusExtracting:
			next = model.AppStatusError
			reason = "上传或解压被服务重启中断；文件已保留，请删除此记录后重新上传"
		case model.AppStatusRegistering:
			next = model.AppStatusRegisterFailed
			reason = "服务重启前未确认注册完成；请重试注册以核对并更新原编码器应用"
		default:
			// Detecting can mean a completed extraction awaiting entry selection.
			// Running is reconciled against native runtime by MonitorStreaming.
			continue
		}
		if err := m.updateStatus(record.ID, next, reason); err != nil {
			return fmt.Errorf("恢复应用 %s 失败: %w", record.ID, err)
		}
		m.logIfErr("record application recovery", m.store.CreateLog("app", record.ID, "recover", "success", reason, nil))
	}
	return nil
}

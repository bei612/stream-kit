package store

import (
	"encoding/json"
	"fmt"

	"github.com/stream-kit/orchestrator/internal/model"
)

type LogQuery struct {
	Page       int
	Size       int
	TargetType string
	TargetID   string
	Operation  string
}

type LogResult struct {
	Items      []model.OperationLog `json:"items"`
	Total      int64                `json:"total"`
	Page       int                  `json:"page"`
	Size       int                  `json:"size"`
}

func (s *Store) CreateLog(targetType, targetID, operation, result, message string, detail interface{}) error {
	var detailStr string
	if detail != nil {
		b, _ := json.Marshal(detail)
		detailStr = string(b)
	}
	log := model.OperationLog{
		TargetType: targetType,
		TargetID:   targetID,
		Operation:  operation,
		Result:     result,
		Message:    message,
		Detail:     detailStr,
	}
	return s.DB.Create(&log).Error
}

func (s *Store) QueryLogs(q LogQuery) (*LogResult, error) {
	if q.Page <= 0 {
		q.Page = 1
	}
	if q.Size <= 0 || q.Size > 100 {
		q.Size = 20
	}

	tx := s.DB.Model(&model.OperationLog{})
	if q.TargetType != "" {
		tx = tx.Where("target_type = ?", q.TargetType)
	}
	if q.TargetID != "" {
		tx = tx.Where("target_id = ?", q.TargetID)
	}
	if q.Operation != "" {
		tx = tx.Where("operation = ?", q.Operation)
	}

	var total int64
	tx.Count(&total)

	var items []model.OperationLog
	err := tx.Order("created_at DESC").
		Offset((q.Page - 1) * q.Size).
		Limit(q.Size).
		Find(&items).Error

	return &LogResult{
		Items: items,
		Total: total,
		Page:  q.Page,
		Size:  q.Size,
	}, err
}

func (s *Store) CleanupLogs(maxAgeDays, maxCount int) (int64, error) {
	var deleted int64

	if maxAgeDays > 0 {
		result := s.DB.Exec(
			"DELETE FROM operation_logs WHERE created_at < datetime('now', ?)",
			fmt.Sprintf("-%d days", maxAgeDays),
		)
		deleted += result.RowsAffected
	}

	if maxCount > 0 {
		result := s.DB.Exec(`
			DELETE FROM operation_logs WHERE id NOT IN (
				SELECT id FROM operation_logs ORDER BY created_at DESC LIMIT ?
			)`, maxCount)
		deleted += result.RowsAffected
	}

	return deleted, nil
}

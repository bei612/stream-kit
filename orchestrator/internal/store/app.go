package store

import (
	"fmt"

	"github.com/stream-kit/orchestrator/internal/model"
	"gorm.io/gorm"
)

func (s *Store) CreateApp(app *model.App) error {
	return s.DB.Create(app).Error
}

func (s *Store) GetApp(id string) (*model.App, error) {
	var app model.App
	if err := s.DB.First(&app, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &app, nil
}

func (s *Store) ListApps() ([]model.App, error) {
	var apps []model.App
	if err := s.DB.Order("created_at DESC").Find(&apps).Error; err != nil {
		return nil, err
	}
	return apps, nil
}

// UpdateAppFields updates only the specified columns. Never overwrites unrelated fields.
func (s *Store) UpdateAppFields(id string, fields map[string]interface{}) error {
	return s.DB.Model(&model.App{}).Where("id = ?", id).Updates(fields).Error
}

// TransitionAppStatus atomically transitions status using compare-and-swap.
// Returns error if the current status doesn't match 'from' (stale write rejected).
func (s *Store) TransitionAppStatus(id string, from, to model.AppStatus, errMsg string) error {
	result := s.DB.Model(&model.App{}).
		Where("id = ? AND status = ?", id, from).
		Updates(map[string]interface{}{
			"status":        to,
			"error_message": errMsg,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fmt.Errorf("状态转换失败：当前状态不是 %s（可能已被其他操作修改）", from)
	}
	return nil
}

// UpdateAppStatus updates status without CAS (for recovery/admin use only).
func (s *Store) UpdateAppStatus(id string, status model.AppStatus, errMsg string) error {
	return s.DB.Model(&model.App{}).Where("id = ?", id).Updates(map[string]interface{}{
		"status":        status,
		"error_message": errMsg,
	}).Error
}

func (s *Store) DeleteApp(id string) error {
	return s.DB.Delete(&model.App{}, "id = ?", id).Error
}

func (s *Store) GetAppByName(name string) (*model.App, error) {
	var app model.App
	if err := s.DB.First(&app, "name = ?", name).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &app, nil
}

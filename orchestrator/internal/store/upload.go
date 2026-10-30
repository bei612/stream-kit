package store

import (
	"errors"
	"github.com/stream-kit/orchestrator/internal/model"
	"gorm.io/gorm"
)

func (s *Store) GetUploadArchive(id string) (*model.UploadArchive, error) {
	var record model.UploadArchive
	err := s.DB.First(&record, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *Store) CreateUploadArchive(record *model.UploadArchive) error {
	return s.DB.Create(record).Error
}

func (s *Store) ListUploadArchives() ([]model.UploadArchive, error) {
	var records []model.UploadArchive
	err := s.DB.Order("created_at ASC").Find(&records).Error
	return records, err
}

func (s *Store) DeleteUploadArchive(id string) error {
	return s.DB.Delete(&model.UploadArchive{}, "id = ?", id).Error
}

package store

import (
	"crypto/rand"
	"encoding/base64"
	"github.com/stream-kit/orchestrator/internal/model"
	"gorm.io/gorm"
)

// PublishWatchLink persists an application-scoped viewing capability. Publishing
// again returns the same link; only an explicit rotation replaces it.
func (s *Store) PublishWatchLink(id string, rotate bool) (string, error) {
	var token string
	err := s.DB.Transaction(func(tx *gorm.DB) error {
		var app model.App
		if err := tx.First(&app, "id = ?", id).Error; err != nil {
			return err
		}
		if app.WatchToken != nil && !rotate {
			token = *app.WatchToken
			return nil
		}
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			return err
		}
		token = base64.RawURLEncoding.EncodeToString(bytes)
		return tx.Model(&app).Update("watch_token", token).Error
	})
	return token, err
}

func (s *Store) DisableWatchLink(id string) error {
	return s.DB.Model(&model.App{}).Where("id = ?", id).Update("watch_token", nil).Error
}

func (s *Store) AppForWatchToken(token string) (*model.App, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(bytes) != 32 || len(token) != 43 {
		return nil, gorm.ErrRecordNotFound
	}
	var app model.App
	if err := s.DB.First(&app, "watch_token = ?", token).Error; err != nil {
		return nil, err
	}
	return &app, nil
}

package store

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"github.com/stream-kit/orchestrator/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type Store struct {
	DB *gorm.DB
}

func New(dbPath string) (*Store, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}

	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(1)

	// SQLite pragmas
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=5000")

	// Auto-migrate
	if err := db.AutoMigrate(&model.App{}, &model.OperationLog{}, &model.StreamSession{}); err != nil {
		return nil, fmt.Errorf("auto migrate: %w", err)
	}
	// Backfill the pre-generation schema exactly once. Subsequent ownership
	// changes store the new revision and generation in the same durable write.
	if err := db.Model(&model.StreamSession{}).Where("control_epoch = 0").Update("control_epoch", gorm.Expr("CASE WHEN revision > 0 THEN revision ELSE 1 END")).Error; err != nil {
		return nil, fmt.Errorf("migrate control epoch: %w", err)
	}

	return &Store{DB: db}, nil
}

func (s *Store) Close() error {
	sqlDB, err := s.DB.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

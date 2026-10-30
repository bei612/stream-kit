package model

import "time"

// UploadArchive records a platform-created staging file before any payload is
// written. It is independent of App because receiving a file precedes creation.
type UploadArchive struct {
	ID        string `gorm:"primaryKey;size:36"`
	Directory string `gorm:"not null"`
	Extension string `gorm:"size:16;not null"`
	CreatedAt time.Time
}

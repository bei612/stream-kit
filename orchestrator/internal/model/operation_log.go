package model

import "time"

type OperationLog struct {
	ID         int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	TargetType string    `json:"target_type" gorm:"size:20;not null;index"`
	TargetID   string    `json:"target_id" gorm:"size:36;index"`
	Operation  string    `json:"operation" gorm:"size:30;not null;index"`
	Result     string    `json:"result" gorm:"size:10;not null"`
	Message    string    `json:"message" gorm:"size:4096"`
	Detail     string    `json:"detail" gorm:"type:text"`
	CreatedAt  time.Time `json:"created_at" gorm:"index"`
}

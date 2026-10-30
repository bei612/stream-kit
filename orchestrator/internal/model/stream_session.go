package model

import "time"

// StreamSession stores the control-plane snapshot. JSON columns keep the
// schema stable while the media plane evolves independently.
type StreamSession struct {
	ControlEpoch           uint64    `json:"control_epoch" gorm:"not null;default:0"`
	Revision               uint64    `json:"revision" gorm:"not null;default:0"`
	ID                     string    `json:"id" gorm:"primaryKey;size:36"`
	HostID                 int64     `json:"host_id" gorm:"index;not null"`
	AppID                  int64     `json:"app_id" gorm:"index;not null"`
	State                  string    `json:"state" gorm:"size:20;not null"`
	ControllerConnectionID string    `json:"controller_connection_id" gorm:"size:36"`
	AudioJSON              string    `json:"audio_json" gorm:"type:text;not null"`
	PolicyJSON             string    `json:"policy_json" gorm:"type:text;not null"`
	ConnectionsJSON        string    `json:"connections_json" gorm:"type:text;not null"`
	CreatedAt              time.Time `json:"created_at"`
	UpdatedAt              time.Time `json:"updated_at"`
}

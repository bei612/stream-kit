package model

import (
	"time"
)

type AppStatus string

type AppSource string

type CaptureMode string

const (
	CaptureDesktop     CaptureMode = "desktop"
	CaptureApplication CaptureMode = "application"
)

func (m CaptureMode) Valid() bool { return m == CaptureDesktop || m == CaptureApplication }

func (m CaptureMode) Normalized() CaptureMode {
	if m == "" {
		return CaptureDesktop
	}
	return m
}

const (
	AppSourceArchive AppSource = "archive"
	AppSourceLocal   AppSource = "local"
)

const (
	AppStatusUploading      AppStatus = "uploading"
	AppStatusExtracting     AppStatus = "extracting"
	AppStatusDetecting      AppStatus = "detecting"
	AppStatusRegistering    AppStatus = "registering"
	AppStatusRegisterFailed AppStatus = "register_failed"
	AppStatusReady          AppStatus = "ready"
	AppStatusRunning        AppStatus = "running"
	AppStatusStopped        AppStatus = "stopped"
	AppStatusCrashed        AppStatus = "crashed"
	AppStatusError          AppStatus = "error"
)

type App struct {
	CaptureMode        CaptureMode `json:"capture_mode" gorm:"size:16;not null;default:'desktop'"`
	Source             AppSource   `json:"source" gorm:"size:16;not null;default:'archive'"`
	ID                 string      `json:"id" gorm:"primaryKey;size:36"`
	Name               string      `json:"name" gorm:"uniqueIndex;size:255;not null"`
	Status             AppStatus   `json:"status" gorm:"size:20;not null;default:'uploading'"`
	ExePath            string      `json:"exe_path" gorm:"size:1024"`
	ExeRelativePath    string      `json:"exe_relative_path" gorm:"size:1024"`
	Args               string      `json:"args" gorm:"size:4096"`
	ArgsTemplate       *string     `json:"args_template" gorm:"size:255"`
	AppDir             string      `json:"app_dir" gorm:"size:1024"`
	WorkingDir         string      `json:"working_dir" gorm:"size:1024"`
	SunshineAppName    string      `json:"sunshine_app_name" gorm:"size:255"`
	SunshineAppID      int         `json:"sunshine_app_id" gorm:"not null;default:0"`
	FileSizeBytes      int64       `json:"file_size_bytes"`
	ExtractedSizeBytes int64       `json:"extracted_size_bytes"`
	StreamURL          string      `json:"stream_url" gorm:"size:1024"`
	ErrorMessage       string      `json:"error_message" gorm:"size:4096"`
	CreatedAt          time.Time   `json:"created_at"`
	UpdatedAt          time.Time   `json:"updated_at"`
}

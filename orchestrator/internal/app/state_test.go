package app

import (
	"testing"

	"github.com/stream-kit/orchestrator/internal/model"
)

func TestValidateTransition_Valid(t *testing.T) {
	tests := []struct {
		from, to model.AppStatus
	}{
		{model.AppStatusUploading, model.AppStatusExtracting},
		{model.AppStatusUploading, model.AppStatusError},
		{model.AppStatusExtracting, model.AppStatusDetecting},
		{model.AppStatusExtracting, model.AppStatusError},
		{model.AppStatusDetecting, model.AppStatusRegistering},
		{model.AppStatusDetecting, model.AppStatusError},
		{model.AppStatusDetecting, model.AppStatusReady},
		{model.AppStatusRegistering, model.AppStatusReady},
		{model.AppStatusRegistering, model.AppStatusRegisterFailed},
		{model.AppStatusRegisterFailed, model.AppStatusRegistering},
		{model.AppStatusRegisterFailed, model.AppStatusError},
		{model.AppStatusReady, model.AppStatusRunning},
		{model.AppStatusReady, model.AppStatusUploading},
		{model.AppStatusReady, model.AppStatusError},
		{model.AppStatusRunning, model.AppStatusStopped},
		{model.AppStatusRunning, model.AppStatusCrashed},
		{model.AppStatusStopped, model.AppStatusRunning},
		{model.AppStatusStopped, model.AppStatusReady},
		{model.AppStatusStopped, model.AppStatusUploading},
		{model.AppStatusStopped, model.AppStatusError},
		{model.AppStatusCrashed, model.AppStatusRunning},
		{model.AppStatusCrashed, model.AppStatusReady},
		{model.AppStatusCrashed, model.AppStatusUploading},
		{model.AppStatusCrashed, model.AppStatusError},
		{model.AppStatusError, model.AppStatusUploading},
		{model.AppStatusError, model.AppStatusError},
	}
	for _, tt := range tests {
		t.Run(string(tt.from)+"→"+string(tt.to), func(t *testing.T) {
			if err := ValidateTransition(tt.from, tt.to); err != nil {
				t.Errorf("expected valid, got error: %v", err)
			}
		})
	}
}

func TestValidateTransition_Invalid(t *testing.T) {
	tests := []struct {
		from, to model.AppStatus
	}{
		{model.AppStatusUploading, model.AppStatusReady},
		{model.AppStatusUploading, model.AppStatusRunning},
		{model.AppStatusExtracting, model.AppStatusUploading},
		{model.AppStatusDetecting, model.AppStatusUploading},
		{model.AppStatusReady, model.AppStatusExtracting},
		{model.AppStatusRunning, model.AppStatusReady},
		{model.AppStatusRunning, model.AppStatusUploading},
		{model.AppStatusError, model.AppStatusReady},
		{model.AppStatusError, model.AppStatusRunning},
	}
	for _, tt := range tests {
		t.Run(string(tt.from)+"→"+string(tt.to), func(t *testing.T) {
			if err := ValidateTransition(tt.from, tt.to); err == nil {
				t.Error("expected error for invalid transition, got nil")
			}
		})
	}
}

func TestValidateTransition_UnknownStatus(t *testing.T) {
	err := ValidateTransition(model.AppStatus("nonexistent"), model.AppStatusReady)
	if err == nil {
		t.Error("expected error for unknown status, got nil")
	}
}

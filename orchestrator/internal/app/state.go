package app

import (
	"fmt"

	"github.com/stream-kit/orchestrator/internal/model"
)

// Transition table: single source of truth for valid state transitions.
var validTransitions = map[model.AppStatus][]model.AppStatus{
	model.AppStatusUploading:      {model.AppStatusExtracting, model.AppStatusError},
	model.AppStatusExtracting:     {model.AppStatusDetecting, model.AppStatusError},
	model.AppStatusDetecting:      {model.AppStatusRegistering, model.AppStatusError, model.AppStatusReady},
	model.AppStatusRegistering:    {model.AppStatusReady, model.AppStatusRegisterFailed},
	model.AppStatusRegisterFailed: {model.AppStatusRegistering, model.AppStatusError},
	model.AppStatusReady:          {model.AppStatusRunning, model.AppStatusStopped, model.AppStatusRegistering, model.AppStatusUploading, model.AppStatusError},
	model.AppStatusRunning:        {model.AppStatusStopped, model.AppStatusCrashed},
	model.AppStatusStopped:        {model.AppStatusRunning, model.AppStatusRegistering, model.AppStatusReady, model.AppStatusUploading, model.AppStatusError},
	model.AppStatusCrashed:        {model.AppStatusRunning, model.AppStatusStopped, model.AppStatusRegistering, model.AppStatusReady, model.AppStatusUploading, model.AppStatusError},
	model.AppStatusError:          {model.AppStatusUploading, model.AppStatusError},
}

// ValidateTransition checks if a state transition is valid.
func ValidateTransition(from, to model.AppStatus) error {
	allowed, ok := validTransitions[from]
	if !ok {
		return fmt.Errorf("未知状态: %s", from)
	}
	for _, s := range allowed {
		if s == to {
			return nil
		}
	}
	return fmt.Errorf("不允许的状态转换: %s → %s", from, to)
}

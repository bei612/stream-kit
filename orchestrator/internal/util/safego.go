package util

import (
	"go.uber.org/zap"
)

// SafeGo launches a goroutine with panic recovery.
// Any panic is logged but does not crash the process.
func SafeGo(logger *zap.Logger, name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Error("goroutine panic recovered",
					zap.String("goroutine", name),
					zap.Any("panic", r),
					zap.Stack("stack"),
				)
			}
		}()
		fn()
	}()
}

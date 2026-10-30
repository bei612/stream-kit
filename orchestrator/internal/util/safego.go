package util

import (
	"go.uber.org/zap"
)

// SafeGo launches a goroutine with panic recovery.
// Any panic is logged but does not crash the process. The returned channel closes
// after the function and panic reporting finish, allowing owners to join cleanup.
func SafeGo(logger *zap.Logger, name string, fn func()) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
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
	return done
}

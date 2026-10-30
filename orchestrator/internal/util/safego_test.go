package util

import (
	"bytes"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func TestSafeGoCompletionIncludesDeferredCleanup(t *testing.T) {
	for _, panicAtExit := range []bool{false, true} {
		var output bytes.Buffer
		logs := zapcore.NewCore(zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig()), zapcore.AddSync(&output), zap.ErrorLevel)
		entered, release := make(chan struct{}), make(chan struct{})
		cleaned := false
		done := SafeGo(zap.New(logs), "owned-worker", func() {
			defer func() { cleaned = true }()
			close(entered)
			<-release
			if panicAtExit {
				panic("test panic")
			}
		})
		<-entered
		select {
		case <-done:
			t.Fatal("worker reported completion while still active")
		default:
		}
		close(release)
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("completion missing")
		}
		if !cleaned {
			t.Fatal("completion preceded deferred cleanup")
		}
		want := 0
		if panicAtExit {
			want = 1
		}
		if reports := bytes.Count(output.Bytes(), []byte(`"msg":"goroutine panic recovered"`)); reports != want {
			t.Fatalf("panic reports=%d want=%d", reports, want)
		}
	}
}

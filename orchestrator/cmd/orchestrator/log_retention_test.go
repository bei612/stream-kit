package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/model"
	"github.com/stream-kit/orchestrator/internal/store"
	"go.uber.org/zap"
)

func TestRetentionStartsAndJoinsServiceShutdown(t *testing.T) {
	st, err := store.New(filepath.Join(t.TempDir(), "logs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for i := 0; i < 3; i++ {
		if err := st.CreateLog("app", "", "update", "ok", "", nil); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runOperationLogRetention(ctx, st, config.OpLogConfig{MaxCount: 1}, zap.NewNop())
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var count int64
		if err := st.DB.Model(&model.OperationLog{}).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("retention did not run at startup")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retention task survived service cancellation")
	}
}

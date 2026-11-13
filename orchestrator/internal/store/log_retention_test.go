package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stream-kit/orchestrator/internal/model"
)

func TestLogRetentionBoundsRowsAndHonorsCancellation(t *testing.T) {
	st := newTestStore(t)
	now := time.Now().UTC()
	for i := 0; i < 12; i++ {
		created := now
		if i < 3 {
			created = now.Add(-10 * 24 * time.Hour)
		}
		if err := st.DB.Create(&model.OperationLog{TargetType: "app", Operation: "update", Result: "ok", CreatedAt: created}).Error; err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := st.CleanupLogs(context.Background(), 7, 5)
	if err != nil || deleted != 7 {
		t.Fatalf("cleanup: %d %v", deleted, err)
	}
	var rows []model.OperationLog
	if err := st.DB.Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 || rows[0].ID != 8 || rows[4].ID != 12 {
		t.Fatalf("did not retain newest five rows: %+v", rows)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := st.CleanupLogs(ctx, 7, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled cleanup: %v", err)
	}
	st.Close()
	if _, err := st.CleanupLogs(context.Background(), 7, 1); err == nil {
		t.Fatal("database error was hidden")
	}
}

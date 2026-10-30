package app

import (
	"github.com/stream-kit/orchestrator/internal/model"
	"testing"
)

func TestCaptureModeRejectedBeforeLocalPersistence(t *testing.T) {
	manager, st, request := localFixture(t)
	for _, mode := range []model.CaptureMode{"window", "APPLICATION", model.CaptureApplication} {
		request.CaptureMode = mode
		if _, err := manager.RegisterLocal(request); err == nil {
			t.Fatalf("accepted unsupported mode %s", mode)
		}
	}
	apps, err := st.ListApps()
	if err != nil || len(apps) != 0 {
		t.Fatalf("invalid request persisted: %v %v", apps, err)
	}
	request.CaptureMode = ""
	record, err := manager.RegisterLocal(request)
	if err != nil {
		t.Fatal(err)
	}
	if record.CaptureMode != model.CaptureDesktop {
		t.Fatalf("legacy default %s", record.CaptureMode)
	}
	mode := model.CaptureApplication
	if err = manager.UpdateApp(record.ID, nil, nil, nil, &mode); err == nil {
		t.Fatal("unsupported update accepted")
	}
	saved, err := st.GetApp(record.ID)
	if err != nil || saved.CaptureMode != model.CaptureDesktop {
		t.Fatalf("unsupported update persisted: %+v %v", saved, err)
	}
}

package handlers

import (
	"context"
	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
	"net/http/httptest"
	"strings"
	"testing"
)

type pairCheckerFake struct{ calls int }

func (f *pairCheckerFake) CheckAudioPair(context.Context, mediacontrol.AudioEndpointPair) (mediacontrol.PairCheckResult, error) {
	f.calls++
	yes := true
	return mediacontrol.PairCheckResult{Passed: &yes}, nil
}
func TestAudioPairCheckRejectsInvalidBodyBeforeDeviceOperation(t *testing.T) {
	f := &pairCheckerFake{}
	router := gin.New()
	router.POST("/check", AudioPairCheck(f))
	for _, body := range []string{`{}`, `{"render_device_id":"same","capture_device_id":"same"}`, `{"render_device_id":"out","capture_device_id":"in","unknown":1}`, `{"render_device_id":"out","capture_device_id":"in"} {}`} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("POST", "/check", strings.NewReader(body)))
		if response.Code != 400 || f.calls != 0 {
			t.Fatalf("status=%d calls=%d", response.Code, f.calls)
		}
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("POST", "/check", strings.NewReader(`{"render_device_id":"out","capture_device_id":"in"}`)))
	if response.Code != 200 || f.calls != 1 {
		t.Fatalf("status=%d calls=%d", response.Code, f.calls)
	}
}

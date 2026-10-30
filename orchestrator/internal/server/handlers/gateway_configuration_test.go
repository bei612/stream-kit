package handlers

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
)

type configurationFake struct {
	err   error
	calls int
}

func (f *configurationFake) GatewayConfiguration(context.Context, string, map[string]json.RawMessage) (*mediacontrol.GatewayConfiguration, error) {
	f.calls++
	return &mediacontrol.GatewayConfiguration{ApplyPolicy: "gateway_restart"}, f.err
}

func TestGatewayConfigurationHTTPValidation(t *testing.T) {
	fake := &configurationFake{}
	r := gin.New()
	r.GET("/config", GatewayConfiguration(fake))
	r.PATCH("/config", GatewayConfiguration(fake))
	for _, tc := range []struct {
		method, body string
		err          error
		status       int
	}{
		{"GET", "", nil, 200},
		{"PATCH", `{}`, nil, 400},
		{"PATCH", `{"revision":"v1","changes":{"/webrtc":{}},"extra":true}`, nil, 400},
		{"PATCH", `{"revision":"v1","changes":{"/webrtc":{}}}`, nil, 200},
		{"PATCH", `{"revision":"v1","changes":{"/webrtc":{}}}`, mediacontrol.ErrConfigurationConflict, 409},
		{"GET", "", mediacontrol.ErrConfigurationUnavailable, 503},
	} {
		fake.err = tc.err
		before := fake.calls
		response := httptest.NewRecorder()
		request := httptest.NewRequest(tc.method, "/config", strings.NewReader(tc.body))
		r.ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Fatal(response.Code, tc.status, response.Body.String())
		}
		if tc.status == 400 && fake.calls != before {
			t.Fatal("invalid body reached native writer")
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("configuration response cacheable")
		}
	}
}

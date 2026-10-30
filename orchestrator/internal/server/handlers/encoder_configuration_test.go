package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/sunshine"
)

type encoderConfigurationFake struct {
	writes int
	err    error
}

func (f *encoderConfigurationFake) ReadConfiguration(context.Context) (sunshine.EncoderConfiguration, error) {
	return sunshine.EncoderConfiguration{Revision: "revision", Values: map[string]json.RawMessage{
		"sunshine_name":    json.RawMessage(`"Renderer"`),
		"pkey":             json.RawMessage(`"private-secret"`),
		"future_extension": json.RawMessage(`{"token":"extension-secret"}`),
		"global_prep_cmd":  json.RawMessage(`[{"do":"command-secret"}]`),
	}}, f.err
}
func (f *encoderConfigurationFake) PatchConfiguration(context.Context, string, map[string]json.RawMessage) (string, error) {
	f.writes++
	return "new-revision", f.err
}

func TestEncoderConfigurationRedactionAndWriteAcknowledgement(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fake := &encoderConfigurationFake{}
	r := gin.New()
	r.GET("/config", EncoderConfiguration(fake))
	r.PATCH("/config", EncoderConfiguration(fake))
	for _, tc := range []struct {
		method, body   string
		err            error
		status, writes int
	}{
		{http.MethodGet, "", nil, 200, 0},
		{http.MethodPatch, `{"revision":"old","changes":{"sunshine_name":"New"}}`, nil, 200, 1},
		{http.MethodPatch, `{"revision":"old","changes":{}}`, nil, 400, 0},
		{http.MethodPatch, `{"revision":"old","changes":{"x":1},"extra":1}`, nil, 400, 0},
		{http.MethodPatch, `{"revision":"old","changes":{"x":1}} {}`, nil, 400, 0},
		{http.MethodPatch, `{"revision":"old","changes":{"x":1}}`, sunshine.ErrConfigurationConflict, 409, 1},
		{http.MethodPatch, `{"revision":"old","changes":{"x":1}}`, sunshine.ErrConfigurationInvalid, 400, 1},
		{http.MethodGet, "", errors.New("private-secret"), 503, 0},
	} {
		fake.err, fake.writes = tc.err, 0
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(tc.method, "/config", strings.NewReader(tc.body)))
		if w.Code != tc.status || fake.writes != tc.writes {
			t.Fatalf("%s status=%d writes=%d", tc.method, w.Code, fake.writes)
		}
		body := w.Body.String()
		if strings.Contains(body, "secret") {
			t.Fatalf("secret leaked: %s", body)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing no-store")
		}
		if tc.method == http.MethodGet && tc.status == 200 {
			if !strings.Contains(body, `"sunshine_name":"Renderer"`) || !strings.Contains(body, `"redacted_keys":["future_extension","global_prep_cmd","pkey"]`) {
				t.Fatalf("incorrect view: %s", body)
			}
		}
		if tc.method == http.MethodPatch && tc.status == 200 {
			if !strings.Contains(body, `"revision":"new-revision"`) || !strings.Contains(body, `"runtime_verified":false`) {
				t.Fatalf("incorrect acknowledgement: %s", body)
			}
		}
	}
}

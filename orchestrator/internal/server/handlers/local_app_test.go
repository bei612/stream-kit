package handlers

import (
	"bytes"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestLocalApplicationRejectsUnknownAndMultipleJSONBeforeMutation(t *testing.T) {
	router := gin.New()
	router.POST("/local", NewAppHandler(nil, nil, nil).RegisterLocal)
	for _, body := range []string{`{"name":"x","app_dir":"external"}`, `{"name":"x","source":"archive"}`, `{} {}`, `{`, string(bytes.Repeat([]byte(" "), 16385)) + `{}`} {
		request := httptest.NewRequest("POST", "/local", bytes.NewBufferString(body))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != 400 {
			t.Fatalf("untrusted body status %d", response.Code)
		}
	}
}

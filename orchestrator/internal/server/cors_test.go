package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORSAllowsConfiguredOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CORSMiddleware([]string{"https://client.example"}))
	r.GET("/health", func(c *gin.Context) { c.Status(http.StatusOK) })
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://client.example")
	res := httptest.NewRecorder()
	r.ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Header().Get("Access-Control-Allow-Origin") != "https://client.example" {
		t.Fatalf("unexpected CORS response: status=%d headers=%v", res.Code, res.Header())
	}
}

func TestCORSRejectsUnknownPreflight(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(CORSMiddleware([]string{"https://client.example"}))
	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	res := httptest.NewRecorder()
	r.ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want %d", res.Code, http.StatusForbidden)
	}
}

func TestCORSFollowsRequestHostWithoutOpeningOtherOrigins(t *testing.T) {
	for _, tc := range []struct {
		host, origin string
		want         bool
	}{
		{"192.168.3.66:9000", "http://192.168.3.66:8080", true},
		{"192.168.3.77:9000", "http://192.168.3.77:8080", true},
		{"render.example:9000", "http://render.example:8080", true},
		{"[::1]:9000", "http://[::1]:8080", true},
		{"192.168.3.77:9000", "http://192.168.3.66:8080", false},
		{"render.example:9000", "http://evil.example:8080", false},
		{"render.example:9000", "http://render.example:8081", false},
		{"render.example:9000", "https://render.example:8080", false},
		{"render.example:9000", "null", false},
	} {
		if got := sameHostOrigin(tc.origin, tc.host, []string{"http://{host}:8080"}); got != tc.want {
			t.Errorf("origin %q for host %q: %v", tc.origin, tc.host, got)
		}
	}
}

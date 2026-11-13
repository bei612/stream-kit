package handlers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestRateLimiterBoundsDistinctPeersWithoutEvictingActiveLimits(t *testing.T) {
	rl := newRateLimiter(1, time.Minute)
	for i := 0; i < rateLimiterMaxEntries; i++ {
		if !rl.allow(fmt.Sprint(i)) {
			t.Fatalf("peer %d rejected before capacity", i)
		}
	}
	for i := 0; i < 10000; i++ {
		if rl.allow(fmt.Sprint(rateLimiterMaxEntries + i)) {
			t.Fatal("capacity exceeded")
		}
	}
	if len(rl.entries) != rateLimiterMaxEntries || rl.allow("0") {
		t.Fatal("active limit lost or map grew")
	}
	for _, entry := range rl.entries {
		entry.resetAt = time.Now().Add(-time.Second)
	}
	rl.cleanup()
	if len(rl.entries) != 0 || !rl.allow("new-peer") {
		t.Fatal("expired capacity not reclaimed")
	}
}

func TestRateLimiterCounterSaturates(t *testing.T) {
	rl := newRateLimiter(1, time.Minute)
	rl.allow("peer")
	for i := 0; i < 10000; i++ {
		if rl.allow("peer") {
			t.Fatal("limit bypass")
		}
	}
	if rl.entries["peer"].count != 1 {
		t.Fatal("rejected attempts must not grow counter")
	}
}

func TestLoginRejectsOversizedBodyAndForwardedIPRotation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := NewAuthHandler("admin", "correct-password", []byte("test-secret"))
	router := gin.New()
	router.POST("/login", h.Login)
	request := func(body, forwarded string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(body))
		req.RemoteAddr = "192.0.2.10:12345"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", forwarded)
		req.Header.Set("X-Real-IP", forwarded)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	large := `{"username":"admin","password":"` + strings.Repeat("x", loginMaxBytes) + `"}`
	if got := request(large, "198.51.100.1").Code; got != http.StatusRequestEntityTooLarge {
		t.Fatalf("large login: %d", got)
	}
	for i := 0; i < 9; i++ {
		if got := request(`{"username":"admin","password":"wrong"}`, fmt.Sprintf("198.51.100.%d", i+2)).Code; got != http.StatusUnauthorized {
			t.Fatalf("attempt %d: %d", i, got)
		}
	}
	if got := request(`{"username":"admin","password":"correct-password"}`, "203.0.113.1").Code; got != http.StatusTooManyRequests {
		t.Fatalf("forwarded headers bypassed limit: %d", got)
	}
	if len(h.limiter.entries) != 1 {
		t.Fatal("untrusted headers added identities")
	}
}

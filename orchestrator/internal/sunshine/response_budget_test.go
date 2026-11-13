package sunshine

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stream-kit/orchestrator/internal/config"
	"go.uber.org/zap"
)

func TestControlResponseBudgetOverRealHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/csrf-token" {
			fmt.Fprintf(w, `{"csrf_token":"%s"}`, strings.Repeat("x", 16<<10))
		} else {
			fmt.Fprintf(w, `{"apps":[{"name":"%s"}]}`, strings.Repeat("x", 8<<20))
		}
	}))
	defer server.Close()
	client := NewClient(config.SunshineAPIConfig{BaseURL: server.URL}, zap.NewNop())
	if _, err := client.GetCSRFToken(context.Background()); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized token: %v", err)
	}
	if _, err := client.ListApps(context.Background()); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("oversized application list: %v", err)
	}
	for _, body := range []string{"", "1234"} {
		if data, err := readControlResponse(strings.NewReader(body), 4); err != nil || string(data) != body {
			t.Fatalf("valid bounded body: %q %v", data, err)
		}
	}
}

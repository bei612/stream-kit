package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/config"
)

func TestConfiguredNodeInventoryUsesOwnSignedConnection(t *testing.T) {
	key := strings.Repeat("n", 32)
	sign := func(domain string, body []byte) string {
		m := hmac.New(sha256.New, []byte(key))
		m.Write([]byte(domain))
		m.Write(body)
		return hex.EncodeToString(m.Sum(nil))
	}
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/gateway/internal/v1/audio-devices" || r.Header.Get("X-Stream-Control-Signature") != sign("stream-kit/audio-devices/request/v1\n", body) {
			w.WriteHeader(401)
			return
		}
		var request struct {
			RequestID string `json:"request_id"`
			IssuedAt  int64  `json:"issued_at_ms"`
		}
		if json.Unmarshal(body, &request) != nil {
			t.Error("invalid node query")
			w.WriteHeader(400)
			return
		}
		response, _ := json.Marshal(map[string]any{"schema_version": 1, "request_id": request.RequestID, "request_issued_at_ms": request.IssuedAt, "observed_at_ms": time.Now().UnixMilli(), "devices": []map[string]any{{"id": "remote-output", "name": "Remote output", "output": true, "input": false}}, "configured_routes": []any{}})
		w.Header().Set("X-Stream-Control-Signature", sign("stream-kit/audio-devices/response/v1\n", response))
		w.Write(response)
	}))
	defer node.Close()
	s := &Server{Config: &config.Config{RenderNodes: map[string]config.RenderNodeConfig{"renderer-a": {Name: "Renderer A", BaseURL: node.URL + "/gateway", ControlSecret: key}}}}
	r := gin.New()
	s.registerRenderNodes(r.Group(""))
	for _, route := range []string{"/render-nodes", "/render-nodes/renderer-a/audio-devices"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", route, nil))
		if w.Code != 200 || strings.Contains(w.Body.String(), key) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("node response %d: %s", w.Code, w.Body.String())
		}
		if route != "/render-nodes" && !strings.Contains(w.Body.String(), "remote-output") {
			t.Fatal("wrong node inventory")
		}
	}
	// Registry reads the running configuration: saved/mutated addresses do not
	// retarget in-flight clients before the explicitly required restart.
	s.Config.RenderNodes["renderer-a"] = config.RenderNodeConfig{Name: "Changed", BaseURL: "https://invalid.example", ControlSecret: "changed"}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/render-nodes/renderer-a/audio-devices", nil))
	if w.Code != 200 {
		t.Fatalf("running registry changed: %s", w.Body.String())
	}
}

package handlers

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/mediacontrol"
	"github.com/stream-kit/orchestrator/internal/session"
	"go.uber.org/zap"
)

type applyClient struct {
	views []*mediacontrol.GatewayConfiguration
	calls int
}

func (f *applyClient) GatewayConfiguration(context.Context, string, map[string]json.RawMessage) (*mediacontrol.GatewayConfiguration, error) {
	i := f.calls
	f.calls++
	if i >= len(f.views) {
		i = len(f.views) - 1
	}
	return f.views[i], nil
}

type applyRestarter struct{ calls int }

func (f *applyRestarter) RestartVerified(ctx context.Context, name string, pid int, instance string, before, after func(context.Context, int, string) error) error {
	f.calls++
	if err := before(ctx, pid, instance); err != nil {
		return err
	}
	return after(ctx, pid+1, strings.Repeat("b", 32))
}

func TestGatewayApplyHTTPBoundaries(t *testing.T) {
	revision := strings.Repeat("c", 64)
	old := &mediacontrol.GatewayConfiguration{Revision: revision, RestartRequired: true, Runtime: &mediacontrol.GatewayRuntimeIdentity{ProcessID: 123, InstanceID: strings.Repeat("a", 32)}}
	current := *old
	current.RestartRequired = false
	current.RunningRevision = &revision
	current.Runtime = &mediacontrol.GatewayRuntimeIdentity{ProcessID: 124, InstanceID: strings.Repeat("b", 32)}
	wrong := current
	wrong.Runtime = old.Runtime
	body := `{"revision":"` + revision + `","instance_id":"` + old.Runtime.InstanceID + `"}`
	for _, tc := range []struct {
		name, url, body string
		views           []*mediacontrol.GatewayConfiguration
		status, calls   int
	}{
		{"apply", "http://127.0.0.1:8080", body, []*mediacontrol.GatewayConfiguration{old, old, &current}, 200, 1},
		{"remote", "http://192.0.2.1:8080", body, []*mediacontrol.GatewayConfiguration{old}, 409, 0},
		{"dns", "http://localhost:8080", body, []*mediacontrol.GatewayConfiguration{old}, 409, 0},
		{"invalid", "http://127.0.0.1:8080", `{"revision":"bad"}`, []*mediacontrol.GatewayConfiguration{old}, 400, 0},
		{"stale-instance", "http://127.0.0.1:8080", body, []*mediacontrol.GatewayConfiguration{&current}, 409, 0},
		{"changed-before-stop", "http://127.0.0.1:8080", body, []*mediacontrol.GatewayConfiguration{old, &current}, 409, 1},
		{"wrong-replacement", "http://127.0.0.1:8080", body, []*mediacontrol.GatewayConfiguration{old, old, &wrong}, 409, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &applyClient{views: tc.views}
			manager := &applyRestarter{}
			r := gin.New()
			r.POST("/apply", GatewayConfigurationApply(client, manager, tc.url))
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("POST", "/apply", strings.NewReader(tc.body)))
			if w.Code != tc.status || manager.calls != tc.calls {
				t.Fatalf("status=%d restarts=%d body=%s", w.Code, manager.calls, w.Body.String())
			}
		})
	}
}

func TestGatewayApplyWithOwnedNativeProcess(t *testing.T) {
	binary := os.Getenv("STREAM_KIT_GATEWAY_EXE")
	if binary == "" {
		t.Skip("set STREAM_KIT_GATEWAY_EXE for native gateway acceptance")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	base := "http://" + address
	dir := t.TempDir()
	configFile := filepath.Join(dir, "config.json")
	secret := strings.Repeat("s", 32)
	raw, err := json.Marshal(map[string]any{"web_server": map[string]any{"bind_address": address, "media_ticket_secret": secret, "control_plane_url": base, "first_login_create_admin": false, "first_login_assign_global_hosts": false}, "webrtc": map[string]any{"ice_servers": []any{}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(configFile, raw, 0600); err != nil {
		t.Fatal(err)
	}
	m := component.NewManager(map[string]config.ComponentConfig{"web_server": {ExePath: binary, WorkingDir: dir, Args: `--config-path "` + configFile + `" run`, PreflightArgs: `--config-path "` + configFile + `" config check`, Env: map[string]string{"WEBRTC_ICE_SERVER_COUNT": "0"}}}, 1, dir, nil, zap.NewNop())
	t.Cleanup(m.Shutdown)
	if err = m.Start("web_server"); err != nil {
		t.Fatal(err)
	}
	client := mediacontrol.New(session.NewManager(nil), base, secret)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var view *mediacontrol.GatewayConfiguration
	for {
		view, err = client.GatewayConfiguration(ctx, "", nil)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("gateway startup", err)
		case <-time.After(100 * time.Millisecond):
		}
	}
	initial := view.Runtime.InstanceID
	view, err = client.GatewayConfiguration(ctx, view.Revision, map[string]json.RawMessage{"/moonlight/pair_device_name": json.RawMessage(`"Managed apply acceptance"`)})
	if err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.POST("/apply", GatewayConfigurationApply(client, m, base))
	body, _ := json.Marshal(map[string]string{"revision": view.Revision, "instance_id": initial})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/apply", strings.NewReader(string(body))))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	applied, err := client.GatewayConfiguration(ctx, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	info, err := m.Get("web_server")
	if err != nil {
		t.Fatal(err)
	}
	if applied.Runtime.InstanceID == initial || int(applied.Runtime.ProcessID) != info.PID || applied.RestartRequired || applied.RunningRevision == nil || *applied.RunningRevision != view.Revision {
		t.Fatal("owned restart was not verified")
	}
	// An old browser submission must not restart the replacement process.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/apply", strings.NewReader(string(body))))
	if w.Code != 409 {
		t.Fatal("stale apply accepted", w.Code)
	}
	after, err := client.GatewayConfiguration(ctx, "", nil)
	if err != nil || after.Runtime.InstanceID != applied.Runtime.InstanceID {
		t.Fatal("stale apply changed replacement", err)
	}
}

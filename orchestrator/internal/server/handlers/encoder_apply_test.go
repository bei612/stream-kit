package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stream-kit/orchestrator/internal/component"
	"github.com/stream-kit/orchestrator/internal/config"
	"github.com/stream-kit/orchestrator/internal/sunshine"
	"go.uber.org/zap"
)

type encoderApplyFake struct {
	states []*sunshine.EncoderConfigurationState
	calls  int
}

func (f *encoderApplyFake) ConfigurationState(context.Context) (*sunshine.EncoderConfigurationState, error) {
	i := f.calls
	f.calls++
	if i >= len(f.states) {
		i = len(f.states) - 1
	}
	return f.states[i], nil
}
func TestEncoderApplyHTTPBoundaries(t *testing.T) {
	revision := `"` + strings.Repeat("c", 64) + `"`
	pending, ready := true, false
	old := &sunshine.EncoderConfigurationState{Revision: revision, LoadedRevision: `"` + strings.Repeat("d", 64) + `"`, InstanceID: strings.Repeat("a", 64), ManagedInstanceID: strings.Repeat("a", 32), ProcessID: 123, RuntimeAvailable: true, RestartRequired: &pending}
	current := *old
	current.ProcessID = 124
	current.InstanceID = strings.Repeat("b", 64)
	current.ManagedInstanceID = strings.Repeat("b", 32)
	current.LoadedRevision = revision
	current.RestartRequired = &ready
	wrong := current
	wrong.LoadedRevision = old.LoadedRevision
	unmanaged := *old
	unmanaged.ManagedInstanceID = ""
	raw, _ := json.Marshal(map[string]string{"revision": revision, "instance_id": old.InstanceID})
	for _, tc := range []struct {
		name, url     string
		states        []*sunshine.EncoderConfigurationState
		status, calls int
	}{
		{"apply", "https://127.0.0.1:1234", []*sunshine.EncoderConfigurationState{old, old, &current}, 200, 1},
		{"remote", "https://192.0.2.1:1234", []*sunshine.EncoderConfigurationState{old}, 409, 0},
		{"dns", "https://localhost:1234", []*sunshine.EncoderConfigurationState{old}, 409, 0},
		{"unmanaged", "https://127.0.0.1:1234", []*sunshine.EncoderConfigurationState{&unmanaged}, 409, 0},
		{"stale", "https://127.0.0.1:1234", []*sunshine.EncoderConfigurationState{&current}, 409, 0},
		{"changed-before-stop", "https://127.0.0.1:1234", []*sunshine.EncoderConfigurationState{old, &current}, 409, 1},
		{"wrong-file-loaded", "https://127.0.0.1:1234", []*sunshine.EncoderConfigurationState{old, old, &wrong}, 409, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &encoderApplyFake{states: tc.states}
			manager := &applyRestarter{}
			r := gin.New()
			r.POST("/apply", EncoderConfigurationApply(client, manager, tc.url))
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("POST", "/apply", strings.NewReader(string(raw))))
			if w.Code != tc.status || manager.calls != tc.calls {
				t.Fatalf("status=%d calls=%d", w.Code, manager.calls)
			}
		})
	}
}

func TestEncoderApplyWithOwnedNativeProcess(t *testing.T) {
	binary := os.Getenv("STREAM_KIT_SUNSHINE_EXE")
	if binary == "" {
		t.Skip("set STREAM_KIT_SUNSHINE_EXE for isolated native restart acceptance")
	}
	dir := t.TempDir()
	base := 0
	for attempt := 0; attempt < 30; attempt++ {
		candidate := 40000 + rand.IntN(15000)
		listeners := []net.Listener{}
		ok := true
		for _, offset := range []int{-5, 0, 1, 21} {
			l, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", candidate+offset))
			if e != nil {
				ok = false
				break
			}
			listeners = append(listeners, l)
		}
		for _, l := range listeners {
			l.Close()
		}
		if ok {
			base = candidate
			break
		}
	}
	if base == 0 {
		t.Fatal("no free isolated encoder port group")
	}
	file := filepath.Join(dir, "sunshine.conf")
	password := uuid.NewString()
	text := fmt.Sprintf("port = %d\nbind_address = 127.0.0.1\naddress_family = ipv4\nsystem_tray = disabled\nupnp = disabled\ncontroller = disabled\ninstall_steam_audio_drivers = disabled\nnvenc_opengl_vulkan_on_dxgi = disabled\nnvenc_latency_over_power = disabled\ndd_configuration_option = disabled\ndd_config_revert_on_disconnect = disabled\nsunshine_name = Before\n", base)
	for key, name := range map[string]string{"pkey": "key.pem", "cert": "cert.pem", "credentials_file": "credentials.json", "file_state": "state.json", "file_apps": "apps.json", "log_path": "sunshine.log"} {
		text += key + " = " + filepath.ToSlash(filepath.Join(dir, name)) + "\n"
	}
	if e := os.WriteFile(file, []byte(text), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "apps.json"), []byte(`{"env":{},"apps":[]}`), 0600); e != nil {
		t.Fatal(e)
	}
	credentials, e := component.StartProcess(binary, `"`+file+`" --creds acceptance `+password, dir, nil, component.NewRingBuffer(50), zap.NewNop())
	if e != nil {
		t.Fatal(e)
	}
	go credentials.RunWait()
	select {
	case <-credentials.Done:
		if credentials.ExitCode != 0 {
			t.Fatal("credential initialization failed")
		}
	case <-time.After(30 * time.Second):
		_ = credentials.Cmd.Process.Kill()
		<-credentials.Done
		t.Fatal("credential initialization timed out")
	}
	manager := component.NewManager(map[string]config.ComponentConfig{"sunshine": {ExePath: binary, WorkingDir: dir, Args: `"` + file + `"`}}, 1, dir, nil, zap.NewNop())
	t.Cleanup(manager.Shutdown)
	if e = manager.Start("sunshine"); e != nil {
		t.Fatal(e)
	}
	url := fmt.Sprintf("https://127.0.0.1:%d", base+1)
	client := sunshine.NewClient(config.SunshineAPIConfig{BaseURL: url, Username: "acceptance", Password: password}, zap.NewNop())
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var before *sunshine.EncoderConfigurationState
	for {
		before, e = client.ConfigurationState(ctx)
		if e == nil {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("encoder startup timed out")
		case <-time.After(200 * time.Millisecond):
		}
	}
	revision, e := client.PatchConfiguration(ctx, before.Revision, map[string]json.RawMessage{"sunshine_name": json.RawMessage(`"After"`)})
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(map[string]string{"revision": revision, "instance_id": before.InstanceID})
	r := gin.New()
	r.POST("/apply", EncoderConfigurationApply(client, manager, url))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/apply", strings.NewReader(string(raw))).WithContext(ctx))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	after, e := client.ConfigurationState(ctx)
	if e != nil {
		t.Fatal(e)
	}
	info, e := manager.Get("sunshine")
	if e != nil {
		t.Fatal(e)
	}
	if after.LoadedRevision != revision || after.InstanceID == before.InstanceID || after.ManagedInstanceID == before.ManagedInstanceID || after.ProcessID != info.PID || *after.RestartRequired {
		t.Fatal("replacement identity or loaded revision mismatch")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/apply", strings.NewReader(string(raw))).WithContext(ctx))
	if w.Code != 409 {
		t.Fatal("stale restart accepted")
	}
	final, e := client.ConfigurationState(ctx)
	if e != nil || final.InstanceID != after.InstanceID {
		t.Fatal("stale request changed replacement")
	}
}

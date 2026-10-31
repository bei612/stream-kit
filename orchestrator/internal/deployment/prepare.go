// Package deployment prepares the complete platform before any service starts.
package deployment

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"

	"github.com/stream-kit/orchestrator/internal/bundle"
	"github.com/stream-kit/orchestrator/internal/config"
)

type Options struct {
	Root          string
	Data          string
	Commit        string
	SessionID     uint32
	UserSID       string
	AdminName     string
	AdminPassword string
}

// Initialize creates a fresh, protected deployment. All component credentials
// travel over stdin. The final directory appears only after every check passes.
// Failed staging directories remain protected for diagnosis; they are never run.
func Initialize(ctx context.Context, options Options) (string, error) {
	if err := ValidateAdministrator(options.AdminName, options.AdminPassword); err != nil {
		return "", err
	}
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("automatic platform setup currently requires Windows; use the Linux deployment units")
	}
	root, err := filepath.Abs(options.Root)
	if err != nil {
		return "", err
	}
	data, err := filepath.Abs(options.Data)
	if err != nil {
		return "", err
	}
	if err := validateLocation(root, data); err != nil {
		return "", err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(data))
	if err != nil {
		return "", fmt.Errorf("data parent directory must already exist: %w", err)
	}
	data = filepath.Join(parent, filepath.Base(data))
	if err := validateLocation(root, data); err != nil {
		return "", err
	}
	if err := config.ValidateWindowsSession("sunshine", config.ComponentConfig{ExePath: "sunshine.exe", WindowsSessionID: options.SessionID, WindowsUserSID: options.UserSID}); err != nil {
		return "", err
	}
	if options.SessionID == 0 || options.UserSID == "" {
		return "", fmt.Errorf("an explicit interactive Windows session and user SID are required")
	}
	if err := requireAdministrator(); err != nil {
		return "", err
	}
	if err := validateRenderUser(options.SessionID, options.UserSID); err != nil {
		return "", err
	}
	manifests, err := bundle.VerifyPlatform(root, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	if options.Commit == "" || manifests["orchestrator"].Commit != options.Commit {
		return "", fmt.Errorf("setup executable and platform payload have different source revisions")
	}
	if _, err := os.Lstat(data); !os.IsNotExist(err) {
		return "", fmt.Errorf("deployment data directory must not already exist")
	}
	if err := os.MkdirAll(filepath.Dir(data), 0700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(filepath.Dir(data), ".stream-kit-setup-")
	if err != nil {
		return "", err
	}
	if err := protectDirectory(stage, options.UserSID, false); err != nil {
		return "", fmt.Errorf("protect staging directory: %w", err)
	}
	if err := prepare(ctx, options, root, data, stage); err != nil {
		return "", fmt.Errorf("setup incomplete; protected staging directory %s: %w", stage, err)
	}
	// Windows rename refuses an existing destination. No existing deployment,
	// database or configuration is merged or overwritten.
	if err := os.Rename(stage, data); err != nil {
		return "", fmt.Errorf("publish prepared deployment (staging %s): %w", stage, err)
	}
	return filepath.Join(data, "orchestrator.json"), nil
}

func ValidateAdministrator(name, password string) error {
	if name == "" && password == "" {
		return nil
	}
	if strings.TrimSpace(name) == "" || len(name) > 128 || strings.IndexFunc(name, unicode.IsControl) >= 0 || len(password) < 12 || len(password) > 1024 {
		return fmt.Errorf("administrator name must contain 1-128 bytes without control characters and password 12-1024 bytes")
	}
	return nil
}

func validateLocation(root, data string) error {
	for _, value := range []string{root, data} {
		if strings.ContainsAny(value, "\x00\r\n\"") {
			return fmt.Errorf("deployment paths cannot contain quotes or control characters")
		}
	}
	for _, pair := range [][2]string{{root, data}, {data, root}} {
		rel, err := filepath.Rel(pair[0], pair[1])
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return fmt.Errorf("program and data directories must be separate, not nested")
		}
	}
	return nil
}

type nativeRunner func(context.Context, string, string, []string, []byte) ([]byte, error)

func prepare(ctx context.Context, options Options, root, data, stage string) error {
	for _, name := range []string{"gateway", "sunshine", "apps", "temp"} {
		folder := filepath.Join(stage, name)
		if err := os.Mkdir(folder, 0700); err != nil {
			return err
		}
		if err := protectDirectory(folder, options.UserSID, true); err != nil {
			return err
		}
	}
	return prepareFiles(ctx, options, root, data, stage, runNative)
}

func prepareFiles(ctx context.Context, options Options, root, data, stage string, run nativeRunner) error {
	controlFile := filepath.Join(stage, "orchestrator.json")
	if err := config.Initialize(controlFile); err != nil {
		return err
	}
	control, err := config.LoadExisting(controlFile)
	if err != nil {
		return err
	}
	if options.AdminName != "" {
		control.Server.Username, control.Server.Password = options.AdminName, options.AdminPassword
	}
	secret := rand.Text() + rand.Text()
	internalPassword := rand.Text() + rand.Text()
	control.Server.MediaTicketSecret = secret
	control.Server.CORSOrigins = []string{"http://127.0.0.1:8080"}
	control.Storage.AppsDir = filepath.Join(data, "apps")
	control.Storage.TempDir = filepath.Join(data, "temp")
	control.Storage.DBPath = filepath.Join(data, "data", "orchestrator.db")
	control.Log.File.Path = filepath.Join(data, "logs", "orchestrator.log")
	control.SunshineAPI = config.SunshineAPIConfig{BaseURL: "https://127.0.0.1:47990", ServerInfoURL: "http://127.0.0.1:47989/serverinfo", Username: "stream-kit", Password: internalPassword, VerifySSL: false}
	control.MoonlightWeb = config.MoonlightWebConfig{BaseURL: "http://127.0.0.1:8080", PublicURL: "http://127.0.0.1:8080", Username: "stream-kit", Password: internalPassword}
	for _, name := range []string{"sunshine", "web_server"} {
		component := control.Components[name]
		component.AutoStart = true
		component.WindowsSessionID, component.WindowsUserSID = options.SessionID, options.UserSID
		if name == "sunshine" {
			component.WorkingDir = filepath.Join(root, "sunshine")
			component.ExePath = filepath.Join(component.WorkingDir, "sunshine.exe")
			component.Args = quote(filepath.Join(data, "sunshine", "sunshine.conf"))
			component.HealthCheck.URL = control.SunshineAPI.ServerInfoURL
		} else {
			component.WorkingDir = filepath.Join(root, "media-gateway")
			component.ExePath = filepath.Join(component.WorkingDir, "web-server.exe")
			prefix := "--config-path " + quote(filepath.Join(data, "gateway", "config.json"))
			component.Args, component.PreflightArgs = prefix+" run", prefix+" config check"
			component.HealthCheck.URL = "http://127.0.0.1:8080/config.js"
		}
		control.Components[name] = component
	}
	credentials, _ := json.Marshal(map[string]string{"name": "stream-kit", "password": internalPassword})
	gateway := control.Components["web_server"].ExePath
	gatewayFile := filepath.Join(stage, "gateway", "config.json")
	defaults, err := run(ctx, gateway, stage, []string{"--config-path", gatewayFile, "config", "print"}, nil)
	if err != nil {
		return err
	}
	var gatewayConfig map[string]any
	if err := json.Unmarshal(defaults, &gatewayConfig); err != nil {
		return fmt.Errorf("gateway returned invalid default configuration")
	}
	web, ok := gatewayConfig["web_server"].(map[string]any)
	if !ok {
		return fmt.Errorf("gateway defaults lack web_server")
	}
	storage, ok := gatewayConfig["data_storage"].(map[string]any)
	if !ok || storage["type"] != "json" {
		return fmt.Errorf("gateway defaults lack supported storage")
	}
	web["bind_address"], web["url_path_prefix"], web["certificate"] = "127.0.0.1:8080", "", nil
	web["first_login_create_admin"], web["session_cookie_secure"] = false, false
	web["media_ticket_secret"], web["control_plane_url"] = secret, "http://127.0.0.1:9000"
	storage["path"] = filepath.Join(stage, "gateway", "data.json")
	if err := writeJSON(gatewayFile, gatewayConfig); err != nil {
		return err
	}
	if _, err := run(ctx, gateway, stage, []string{"--config-path", gatewayFile, "initialize-admin"}, credentials); err != nil {
		return err
	}
	storage["path"] = filepath.Join(data, "gateway", "data.json")
	if err := writeJSON(gatewayFile, gatewayConfig); err != nil {
		return err
	}
	if _, err := run(ctx, gateway, stage, []string{"--config-path", gatewayFile, "config", "check"}, nil); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(stage, "sunshine", "apps.json"), map[string]any{"env": map[string]string{}, "apps": []any{}}); err != nil {
		return err
	}
	sunshineFile := filepath.Join(stage, "sunshine", "sunshine.conf")
	if err := os.WriteFile(sunshineFile, []byte(rendererConfig(filepath.Join(stage, "sunshine"))), 0600); err != nil {
		return err
	}
	if _, err := run(ctx, control.Components["sunshine"].ExePath, stage, []string{sunshineFile, "--creds-stdin"}, credentials); err != nil {
		return err
	}
	if err := os.WriteFile(sunshineFile, []byte(rendererConfig(filepath.Join(data, "sunshine"))), 0600); err != nil {
		return err
	}
	if err := writeJSON(controlFile, control); err != nil {
		return err
	}
	_, err = config.LoadExisting(controlFile)
	return err
}

func quote(value string) string { return "\"" + value + "\"" }

func writeJSON(file string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(file, append(data, '\n'), 0600)
}

func rendererConfig(directory string) string {
	native := func(name string) string { return filepath.ToSlash(filepath.Join(directory, name)) }
	return "bind_address = 127.0.0.1\nport = 47989\nsystem_tray = disabled\nupnp = disabled\ninstall_steam_audio_drivers = disabled\ndd_configuration_option = disabled\ndd_config_revert_on_disconnect = disabled\nnvenc_opengl_vulkan_on_dxgi = disabled\nnvenc_latency_over_power = disabled\n" +
		"file_apps = " + native("apps.json") + "\nfile_state = " + native("state.json") + "\ncredentials_file = " + native("credentials.json") +
		"\npkey = " + native("key.pem") + "\ncert = " + native("cert.pem") + "\nlog_path = " + native("sunshine.log") + "\nsunshine_name = Stream-Kit\n"
}

func runNative(ctx context.Context, binary, directory string, args []string, input []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = directory
	cmd.Stdin = bytes.NewReader(input)
	// Child diagnostics may contain credentials/configuration. Return only the
	// executable and operation outcome, never raw stdout/stderr on failure.
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%s configuration operation failed: %w", filepath.Base(binary), err)
	}
	return output, nil
}

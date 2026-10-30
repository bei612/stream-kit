package config

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	sourcePath     string
	sourceRevision string
	Server         ServerConfig               `json:"server" mapstructure:"server"`
	Components     map[string]ComponentConfig `json:"components" mapstructure:"components"`
	SunshineAPI    SunshineAPIConfig          `json:"sunshine_api" mapstructure:"sunshine_api"`
	MoonlightWeb   MoonlightWebConfig         `json:"moonlight_web" mapstructure:"moonlight_web"`
	Storage        StorageConfig              `json:"storage" mapstructure:"storage"`
	Process        ProcessConfig              `json:"process" mapstructure:"process"`
	Notifications  NotificationsConfig        `json:"notifications" mapstructure:"notifications"`
	Log            LogConfig                  `json:"log" mapstructure:"log"`
	Templates      map[string]string          `json:"templates" mapstructure:"templates"`
}

type ServerConfig struct {
	BindAddress       string   `json:"bind_address" mapstructure:"bind_address"`
	Username          string   `json:"username" mapstructure:"username"`
	Password          string   `json:"password" mapstructure:"password"`
	JWTSecret         string   `json:"jwt_secret" mapstructure:"jwt_secret"`
	MediaTicketSecret string   `json:"media_ticket_secret" mapstructure:"media_ticket_secret"`
	CORSOrigins       []string `json:"cors_origins" mapstructure:"cors_origins"`
	TLSCert           string   `json:"tls_cert" mapstructure:"tls_cert"`
	TLSKey            string   `json:"tls_key" mapstructure:"tls_key"`
}

type ComponentConfig struct {
	ExePath            string            `json:"exe_path" mapstructure:"exe_path"`
	Args               string            `json:"args" mapstructure:"args"`
	WorkingDir         string            `json:"working_dir" mapstructure:"working_dir"`
	Env                map[string]string `json:"env" mapstructure:"env"`
	AutoStart          bool              `json:"auto_start" mapstructure:"auto_start"`
	RestartOnCrash     bool              `json:"restart_on_crash" mapstructure:"restart_on_crash"`
	RestartDelay       int               `json:"restart_delay_seconds" mapstructure:"restart_delay_seconds"`
	MaxRestartAttempts int               `json:"max_restart_attempts" mapstructure:"max_restart_attempts"`
	HealthCheck        HealthCheckConfig `json:"health_check" mapstructure:"health_check"`
}

type HealthCheckConfig struct {
	Type                  string `json:"type" mapstructure:"type"`
	URL                   string `json:"url" mapstructure:"url"`
	IntervalSeconds       int    `json:"interval_seconds" mapstructure:"interval_seconds"`
	TimeoutSeconds        int    `json:"timeout_seconds" mapstructure:"timeout_seconds"`
	UnhealthyThreshold    int    `json:"unhealthy_threshold" mapstructure:"unhealthy_threshold"`
	HealthyThreshold      int    `json:"healthy_threshold" mapstructure:"healthy_threshold"`
	StartupTimeoutSeconds int    `json:"startup_timeout_seconds" mapstructure:"startup_timeout_seconds"`
	VerifySSL             *bool  `json:"verify_ssl,omitempty" mapstructure:"verify_ssl"`
}

type SunshineAPIConfig struct {
	BaseURL       string `json:"base_url" mapstructure:"base_url"`
	ServerInfoURL string `json:"server_info_url,omitempty" mapstructure:"server_info_url"`
	Username      string `json:"username" mapstructure:"username"`
	Password      string `json:"password" mapstructure:"password"`
	VerifySSL     bool   `json:"verify_ssl" mapstructure:"verify_ssl"`
}

type MoonlightWebConfig struct {
	PublicURL string `json:"public_url" mapstructure:"public_url"`
	BaseURL   string `json:"base_url" mapstructure:"base_url"`
	Username  string `json:"username" mapstructure:"username"`
	Password  string `json:"password" mapstructure:"password"`
}

type StorageConfig struct {
	AppsDir        string `json:"apps_dir" mapstructure:"apps_dir"`
	TempDir        string `json:"temp_dir" mapstructure:"temp_dir"`
	DBPath         string `json:"db_path" mapstructure:"db_path"`
	MaxUploadSize  int64  `json:"max_upload_size_bytes" mapstructure:"max_upload_size_bytes"`
	MaxExtractSize int64  `json:"max_extract_size_bytes" mapstructure:"max_extract_size_bytes"`
	MaxFileCount   int    `json:"max_file_count" mapstructure:"max_file_count"`
}

type ProcessConfig struct {
	MonitorInterval         int `json:"monitor_interval_seconds" mapstructure:"monitor_interval_seconds"`
	GracefulShutdownTimeout int `json:"graceful_shutdown_timeout_seconds" mapstructure:"graceful_shutdown_timeout_seconds"`
}

type NotificationsConfig struct {
	WebhookURL string   `json:"webhook_url" mapstructure:"webhook_url"`
	Events     []string `json:"events" mapstructure:"events"`
}

type LogConfig struct {
	Level        string          `json:"level" mapstructure:"level"`
	File         LogFileConfig   `json:"file" mapstructure:"file"`
	AccessLog    AccessLogConfig `json:"access_log" mapstructure:"access_log"`
	OperationLog OpLogConfig     `json:"operation_log" mapstructure:"operation_log"`
}

type LogFileConfig struct {
	Enabled    bool   `json:"enabled" mapstructure:"enabled"`
	Path       string `json:"path" mapstructure:"path"`
	MaxSizeMB  int    `json:"max_size_mb" mapstructure:"max_size_mb"`
	MaxBackups int    `json:"max_backups" mapstructure:"max_backups"`
	MaxAgeDays int    `json:"max_age_days" mapstructure:"max_age_days"`
	Compress   bool   `json:"compress" mapstructure:"compress"`
}

type AccessLogConfig struct {
	Enabled      bool     `json:"enabled" mapstructure:"enabled"`
	ExcludePaths []string `json:"exclude_paths" mapstructure:"exclude_paths"`
}

type OpLogConfig struct {
	MaxAgeDays int `json:"max_age_days" mapstructure:"max_age_days"`
	MaxCount   int `json:"max_count" mapstructure:"max_count"`
}

// BaseDir is the directory containing config.json, used to resolve relative paths.
var BaseDir string

func Load(configPath string) (*Config, error) {
	if configPath == "" {
		configPath = "config.json"
	}

	absPath, err := filepath.Abs(configPath)
	if err != nil {
		return nil, fmt.Errorf("resolve config path: %w", err)
	}
	BaseDir = filepath.Dir(absPath)

	// First-run: generate default config if missing
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		if err := generateDefaultConfig(absPath); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("首次运行，已生成默认配置：%s\n请检查配置后重新启动", absPath)
	}

	source, err := os.ReadFile(absPath)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	cfg, err := decodeSettings(source)
	if err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg, err = deploymentConfig(cfg)
	if err != nil {
		return nil, err
	}

	resolvePaths(cfg)
	cfg.sourcePath, cfg.sourceRevision = absPath, revision(source)

	return cfg, nil
}

// deploymentConfig derives the effective configuration without mutating the
// file snapshot. Startup and editing must validate the same environment overlay;
// callers persist only the original snapshot, never deployment credentials.
func deploymentConfig(file *Config) (*Config, error) {
	effective := *file
	if err := applyEnvironment(&effective); err != nil {
		return nil, err
	}
	if issues := validate(&effective); len(issues) != 0 {
		return nil, fmt.Errorf("config validation errors:\n  %s", strings.Join(issues, "\n  "))
	}
	return &effective, nil
}

func resolvePaths(cfg *Config) {
	resolve := func(p string) string {
		if p == "" || filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(BaseDir, p)
	}
	cfg.Storage.AppsDir = resolve(cfg.Storage.AppsDir)
	cfg.Storage.TempDir = resolve(cfg.Storage.TempDir)
	cfg.Storage.DBPath = resolve(cfg.Storage.DBPath)
	cfg.Server.TLSCert = resolve(cfg.Server.TLSCert)
	cfg.Server.TLSKey = resolve(cfg.Server.TLSKey)
	cfg.Log.File.Path = resolve(cfg.Log.File.Path)
	for name, comp := range cfg.Components {
		comp.ExePath = resolve(comp.ExePath)
		comp.WorkingDir = resolve(comp.WorkingDir)
		cfg.Components[name] = comp
	}
}

func validate(cfg *Config) []string {
	var errs []string
	check := func(cond bool, msg string) {
		if cond {
			errs = append(errs, msg)
		}
	}

	check(cfg.Server.BindAddress == "", "server.bind_address 不能为空")
	_, port, bindErr := net.SplitHostPort(cfg.Server.BindAddress)
	portNumber, portErr := strconv.Atoi(port)
	check(bindErr != nil || portErr != nil || portNumber < 1 || portNumber > 65535, "server.bind_address 必须包含有效主机与端口")
	check((cfg.Server.TLSCert == "") != (cfg.Server.TLSKey == ""), "TLS 证书与私钥路径必须同时设置或清空")
	check(cfg.Server.Username == "", "server.username 不能为空")
	check(cfg.Server.Password == "", "server.password 不能为空")
	check(cfg.Storage.AppsDir == "", "storage.apps_dir 不能为空")
	check(cfg.Storage.TempDir == "", "storage.temp_dir 不能为空")
	check(cfg.Storage.DBPath == "", "storage.db_path 不能为空")
	check(cfg.Storage.MaxUploadSize <= 0, "storage.max_upload_size_bytes 必须 > 0")
	check(cfg.Storage.MaxExtractSize <= 0, "storage.max_extract_size_bytes 必须 > 0")
	check(cfg.Storage.MaxFileCount <= 0, "storage.max_file_count 必须 > 0")
	check(cfg.Process.MonitorInterval <= 0, "process.monitor_interval_seconds 必须 > 0")
	check(cfg.Process.GracefulShutdownTimeout < 0, "process.graceful_shutdown_timeout_seconds 不能为负数")
	for name, component := range cfg.Components {
		prefix := "components." + name
		check(component.RestartDelay < 0 || component.MaxRestartAttempts < 0, prefix+" 重启等待与次数不能为负数")
		health := component.HealthCheck
		if health.URL != "" {
			check(!validServiceURL(health.URL), prefix+" 健康检查地址必须为无凭据的 HTTP(S) 地址")
			check(health.IntervalSeconds <= 0 || health.TimeoutSeconds <= 0 || health.UnhealthyThreshold <= 0 || health.HealthyThreshold <= 0, prefix+" 健康检查间隔、超时和判定次数必须 > 0")
		}
	}
	check(cfg.Log.File.MaxSizeMB < 0 || cfg.Log.File.MaxBackups < 0 || cfg.Log.File.MaxAgeDays < 0 || cfg.Log.OperationLog.MaxAgeDays < 0 || cfg.Log.OperationLog.MaxCount < 0, "日志保留限制不能为负数")
	if cfg.Server.MediaTicketSecret != "" {
		check(len(cfg.Server.MediaTicketSecret) < 32, "server.media_ticket_secret 必须至少 32 字节")
		check(len(cfg.Server.JWTSecret) < 32, "托管串流必须配置至少 32 字节的 server.jwt_secret")
		check(!validServiceURL(cfg.MoonlightWeb.BaseURL), "moonlight_web.base_url 必须是无凭据的 HTTP(S) 地址")
	}
	if cfg.MoonlightWeb.PublicURL != "" {
		check(!validServiceURL(cfg.MoonlightWeb.PublicURL), "moonlight_web.public_url 必须是无凭据的 HTTP(S) 地址")
	}

	return errs
}

func validServiceURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}

func generateDefaultConfig(path string) error {
	examplePath := filepath.Join(filepath.Dir(path), "config.example.json")
	data, err := os.ReadFile(examplePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read example configuration: %w", err)
	}
	if os.IsNotExist(err) {
		// Use the same typed schema as loading and editing. A first-run file
		// must not depend on a separately maintained subset of JSON fields.
		cfg := Config{
			Server:     ServerConfig{BindAddress: "127.0.0.1:9000", Username: "admin", Password: rand.Text(), JWTSecret: rand.Text() + rand.Text()},
			Components: map[string]ComponentConfig{},
			Storage:    StorageConfig{AppsDir: "./apps", TempDir: "./temp", DBPath: "./data/orchestrator.db", MaxUploadSize: 50 << 30, MaxExtractSize: 50 << 30, MaxFileCount: 100000},
			Process:    ProcessConfig{MonitorInterval: 5, GracefulShutdownTimeout: 5},
			Log:        LogConfig{Level: "info", File: LogFileConfig{Enabled: true, Path: "./logs/orchestrator.log", MaxSizeMB: 100, MaxBackups: 5, MaxAgeDays: 30, Compress: true}, OperationLog: OpLogConfig{MaxAgeDays: 30, MaxCount: 100000}},
			Templates:  map[string]string{"fullscreen_1080p": "-game -fullscreen -ResX=1920 -ResY=1080 -ForceRes"},
		}
		data, err = json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			return err
		}
	}
	cfg, err := decodeSettings(data)
	if err != nil {
		return fmt.Errorf("invalid example configuration: %w", err)
	}
	if _, err := deploymentConfig(cfg); err != nil {
		return fmt.Errorf("invalid example configuration: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	// Never truncate configuration created concurrently by another starter.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

// Sanitized returns a copy of the config with sensitive fields masked.
func (c *Config) Sanitized() map[string]interface{} {
	data, _ := json.Marshal(c)
	var m map[string]interface{}
	json.Unmarshal(data, &m)

	// Mask sensitive fields
	mask := func(obj map[string]interface{}, key string) {
		if v, ok := obj[key].(string); ok && v != "" {
			obj[key] = "****"
		}
	}
	if srv, ok := m["server"].(map[string]interface{}); ok {
		mask(srv, "password")
		mask(srv, "jwt_secret")
		mask(srv, "media_ticket_secret")
	}
	if sun, ok := m["sunshine_api"].(map[string]interface{}); ok {
		mask(sun, "password")
	}
	if moon, ok := m["moonlight_web"].(map[string]interface{}); ok {
		mask(moon, "password")
	}
	for _, section := range []string{"sunshine_api", "moonlight_web"} {
		if service, ok := m[section].(map[string]interface{}); ok {
			for _, key := range []string{"base_url", "public_url", "server_info_url"} {
				if address, ok := service[key].(string); ok {
					service[key] = sanitizedURL(address)
				}
			}
		}
	}
	// Free-form environment values and command lines can carry credentials in
	// arbitrary names/formats. Never infer safety from a variable name or expose
	// a credential prefix. This projection is display-only, not a save payload.
	if components, ok := m["components"].(map[string]interface{}); ok {
		for _, raw := range components {
			if component, ok := raw.(map[string]interface{}); ok {
				mask(component, "args")
				if env, ok := component["env"].(map[string]interface{}); ok {
					for key := range env {
						mask(env, key)
					}
				}
				if health, ok := component["health_check"].(map[string]interface{}); ok {
					if address, ok := health["url"].(string); ok {
						health["url"] = sanitizedURL(address)
					}
				}
			}
		}
	}
	if notifications, ok := m["notifications"].(map[string]interface{}); ok {
		// Webhook credentials may be embedded in the URL path as well as query.
		mask(notifications, "webhook_url")
	}
	if templates, ok := m["templates"].(map[string]interface{}); ok {
		for key := range templates {
			mask(templates, key)
		}
	}
	return m
}

func sanitizedURL(address string) string {
	if address == "" {
		return ""
	}
	u, err := url.Parse(address)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "****"
	}
	// Even path segments can be bearer credentials. Retain only the origin so
	// administrators can identify the destination without exposing its secrets.
	return (&url.URL{Scheme: u.Scheme, Host: u.Host}).String()
}

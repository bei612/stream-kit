package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	Server        ServerConfig               `json:"server" mapstructure:"server"`
	Components    map[string]ComponentConfig `json:"components" mapstructure:"components"`
	SunshineAPI   SunshineAPIConfig          `json:"sunshine_api" mapstructure:"sunshine_api"`
	MoonlightWeb  MoonlightWebConfig         `json:"moonlight_web" mapstructure:"moonlight_web"`
	Storage       StorageConfig              `json:"storage" mapstructure:"storage"`
	Process       ProcessConfig              `json:"process" mapstructure:"process"`
	Notifications NotificationsConfig        `json:"notifications" mapstructure:"notifications"`
	Log           LogConfig                  `json:"log" mapstructure:"log"`
	Templates     map[string]string          `json:"templates" mapstructure:"templates"`
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

	v := viper.New()
	v.SetConfigFile(absPath)
	v.SetConfigType("json")
	v.SetEnvPrefix("ORCH")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	resolvePaths(&cfg)

	if errs := validate(&cfg); len(errs) > 0 {
		return nil, fmt.Errorf("config validation errors:\n  %s", strings.Join(errs, "\n  "))
	}

	return &cfg, nil
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
	check(cfg.Server.Username == "", "server.username 不能为空")
	check(cfg.Server.Password == "", "server.password 不能为空")
	check(cfg.Storage.AppsDir == "", "storage.apps_dir 不能为空")
	check(cfg.Storage.TempDir == "", "storage.temp_dir 不能为空")
	check(cfg.Storage.DBPath == "", "storage.db_path 不能为空")
	check(cfg.Storage.MaxUploadSize <= 0, "storage.max_upload_size_bytes 必须 > 0")
	check(cfg.Storage.MaxExtractSize <= 0, "storage.max_extract_size_bytes 必须 > 0")
	check(cfg.Storage.MaxFileCount <= 0, "storage.max_file_count 必须 > 0")
	check(cfg.Process.MonitorInterval <= 0, "process.monitor_interval_seconds 必须 > 0")
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
	if err != nil {
		cfg := map[string]interface{}{
			"server": map[string]interface{}{
				"bind_address": "0.0.0.0:9000",
				"username":     "admin",
				"password":     "admin",
				"log_level":    "info",
			},
			"components": map[string]interface{}{},
			"storage": map[string]interface{}{
				"apps_dir":              "./apps",
				"temp_dir":              "./temp",
				"db_path":               "./data/orchestrator.db",
				"max_upload_size_bytes": 53687091200,
			},
			"process": map[string]interface{}{
				"monitor_interval_seconds": 5,
			},
			"templates": map[string]interface{}{
				"fullscreen_1080p": "-game -fullscreen -ResX=1920 -ResY=1080 -ForceRes",
			},
		}
		data, _ = json.MarshalIndent(cfg, "", "  ")
	}

	os.MkdirAll(filepath.Dir(path), 0755)
	return os.WriteFile(path, data, 0600)
}

// Sanitized returns a copy of the config with sensitive fields masked.
func (c *Config) Sanitized() map[string]interface{} {
	data, _ := json.Marshal(c)
	var m map[string]interface{}
	json.Unmarshal(data, &m)

	// Mask sensitive fields
	mask := func(obj map[string]interface{}, key string) {
		if v, ok := obj[key].(string); ok && v != "" {
			if len(v) > 4 {
				obj[key] = v[:4] + "****"
			} else {
				obj[key] = "****"
			}
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
	return m
}

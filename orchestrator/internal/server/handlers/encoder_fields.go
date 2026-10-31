package handlers

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// These reviewed fields mirror src/config.cpp and the settings UI in the vendored encoder.
// The catalog describes editable overrides, not platform-dependent defaults.
type encoderField struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Description string   `json:"description,omitempty"`
	Type        string   `json:"type"`
	Minimum     float64  `json:"minimum,omitempty"`
	Maximum     float64  `json:"maximum,omitempty"`
	Choices     []string `json:"choices,omitempty"`
}

var encoderFields = []encoderField{
	{Key: "sunshine_name", Label: "渲染节点名称", Type: "string"},
	{Key: "port", Label: "渲染服务基础端口", Description: "重启生效。同步调整网关的主机端口、控制端编码器地址和防火墙规则；相关服务使用该端口的固定偏移。", Type: "integer", Minimum: 1019, Maximum: 65514},
	{Key: "address_family", Label: "渲染服务地址族", Type: "string", Choices: []string{"ipv4", "both"}},
	{Key: "bind_address", Label: "渲染服务监听 IP", Description: "填写服务器本机 IP；留空使用默认监听。IPv6 需要地址族为 both。更改后需同步调整控制端和网关连接地址。", Type: "string"},
	{Key: "external_ip", Label: "对客户端公布的外部 IP", Type: "string"},
	{Key: "origin_web_ui_allowed", Label: "编码器原生管理接口访问范围", Description: "pc 仅本机，lan 局域网，wan 广域网。跨节点控制端必须位于允许范围内；此项不替代统一管理端身份认证。", Type: "string", Choices: []string{"pc", "lan", "wan"}},
	{Key: "upnp", Label: "自动申请路由器端口映射", Description: "启用后编码器会通过 UPnP 请求路由器开放端口；按实际网络部署需求配置。", Type: "boolean"},
	{Key: "notify_pre_releases", Label: "编码器预发布版本通知", Type: "boolean"},
	{Key: "capture", Label: "画面采集方式", Type: "string"},
	{Key: "encoder", Label: "编码器", Type: "string"},
	{Key: "adapter_name", Label: "显卡", Type: "string"},
	{Key: "output_name", Label: "显示输出", Type: "string"},
	{Key: "dd_configuration_option", Label: "显示设备准备策略", Type: "string", Choices: []string{"disabled", "verify_only", "ensure_active", "ensure_primary", "ensure_only_display"}},
	{Key: "dd_resolution_option", Label: "显示分辨率策略", Type: "string", Choices: []string{"disabled", "auto", "manual"}},
	{Key: "dd_manual_resolution", Label: "手动分辨率（例如 1920x1080）", Type: "string"},
	{Key: "dd_refresh_rate_option", Label: "显示刷新率策略", Type: "string", Choices: []string{"disabled", "auto", "manual"}},
	{Key: "dd_manual_refresh_rate", Label: "手动刷新率（Hz，例如 59.94）", Type: "string"},
	{Key: "dd_hdr_option", Label: "显示 HDR 策略", Type: "string", Choices: []string{"disabled", "auto"}},
	{Key: "dd_config_revert_delay", Label: "显示配置恢复延迟（毫秒）", Type: "integer", Maximum: 2147483647},
	{Key: "dd_config_revert_on_disconnect", Label: "客户端断开时恢复显示配置", Type: "boolean"},
	{Key: "dd_wa_hdr_toggle_delay", Label: "HDR 切换延迟（毫秒）", Type: "integer", Maximum: 3000},
	{Key: "audio_sink", Label: "主机声音设备", Type: "string"},
	{Key: "virtual_sink", Label: "虚拟声音设备", Type: "string"},
	{Key: "stream_audio", Label: "传输主机声音", Type: "boolean"},
	{Key: "max_bitrate", Label: "最大码率（kbps，0 为不限制）", Type: "integer", Maximum: 2147483647},
	{Key: "minimum_fps_target", Label: "最低目标帧率（0 使用默认策略）", Type: "number", Maximum: 1000},
	{Key: "hevc_mode", Label: "HEVC 支持模式（0 自动，1 禁用，2 主档次，3 含 Main10）", Type: "integer", Maximum: 3},
	{Key: "av1_mode", Label: "AV1 支持模式（0 自动，1 禁用，2 8 位，3 含 10 位）", Type: "integer", Maximum: 3},
	{Key: "min_threads", Label: "CPU 编码最少线程数", Type: "integer", Minimum: 1, Maximum: 2147483647},
	{Key: "sw_preset", Label: "软件编码速度与压缩预设", Type: "string", Choices: []string{"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}},
	{Key: "sw_tune", Label: "软件编码内容调优", Type: "string", Choices: []string{"film", "animation", "grain", "stillimage", "fastdecode", "zerolatency"}},
	{Key: "nvenc_preset", Label: "NVIDIA 编码预设（1 最快，7 质量优先）", Type: "integer", Minimum: 1, Maximum: 7},
	{Key: "nvenc_vbv_increase", Label: "NVIDIA VBV 缓冲增量（%）", Type: "integer", Maximum: 400},
	{Key: "nvenc_spatial_aq", Label: "NVIDIA 空间自适应量化", Type: "boolean"},
	{Key: "nvenc_twopass", Label: "NVIDIA 多遍编码", Type: "string", Choices: []string{"disabled", "quarter_res", "full_res"}},
	{Key: "nvenc_split_encode", Label: "NVIDIA 分帧编码", Type: "string", Choices: []string{"disabled", "driver_decides", "enabled"}},
	{Key: "nvenc_h264_cavlc", Label: "NVIDIA H.264 使用 CAVLC", Type: "boolean"},
	{Key: "nvenc_realtime_hags", Label: "NVIDIA HAGS 实时优先级", Type: "boolean"},
	{Key: "nvenc_opengl_vulkan_on_dxgi", Label: "NVIDIA DXGI 采集 OpenGL/Vulkan", Type: "boolean"},
	{Key: "nvenc_latency_over_power", Label: "NVIDIA 优先低延迟而非节能", Type: "boolean"},
	{Key: "qsv_slow_hevc", Label: "Intel 启用较慢的 HEVC 编码器", Type: "boolean"},
	{Key: "qsv_preset", Label: "Intel 编码预设", Type: "string", Choices: []string{"veryslow", "slower", "slow", "medium", "fast", "faster", "veryfast"}},
	{Key: "qsv_coder", Label: "Intel 熵编码", Type: "string", Choices: []string{"auto", "cabac", "ac", "cavlc", "vlc"}},
	{Key: "vk_tune", Label: "Vulkan 编码调优（0 自动，1 高质量，2 低延迟，3 超低延迟）", Type: "integer", Maximum: 3, Choices: []string{"0", "1", "2", "3"}},
	{Key: "vk_rc_mode", Label: "Vulkan 码率控制（0 自动，1 CQP，2 CBR，4 VBR）", Type: "integer", Maximum: 4, Choices: []string{"0", "1", "2", "4"}},
	{Key: "amd_quality", Label: "AMD 编码质量", Type: "string", Choices: []string{"balanced", "quality", "speed"}},
	{Key: "amd_rc", Label: "AMD 码率控制", Type: "string", Choices: []string{"cbr", "cqp", "vbr_latency", "vbr_peak"}},
	{Key: "amd_usage", Label: "AMD 编码用途", Type: "string", Choices: []string{"lowlatency", "lowlatency_high_quality", "transcoding", "ultralowlatency", "webcam"}},
	{Key: "amd_coder", Label: "AMD 熵编码", Type: "string", Choices: []string{"auto", "cabac", "ac", "cavlc", "vlc"}},
	{Key: "amd_preanalysis", Label: "AMD 编码预分析", Type: "boolean"},
	{Key: "amd_vbaq", Label: "AMD 方差自适应量化", Type: "boolean"},
	{Key: "amd_enforce_hrd", Label: "AMD 强制 HRD 缓冲约束", Type: "boolean"},
	{Key: "amd_max_au_size", Label: "AMD 最大访问单元大小（bit，-1 使用编码器默认值）", Type: "integer", Minimum: -1, Maximum: 2147483647},
	{Key: "vaapi_blbrc", Label: "VAAPI 块级码率控制", Type: "boolean"},
	{Key: "vaapi_quality", Label: "VAAPI 编码质量", Type: "string", Choices: []string{"balanced", "quality", "speed"}},
	{Key: "vaapi_rc", Label: "VAAPI 码率控制", Type: "string", Choices: []string{"avbr", "cbr", "cqp", "icq", "qvbr", "vbr"}},
	{Key: "vaapi_strict_rc_buffer", Label: "VAAPI 严格码率缓冲", Type: "boolean"},
	{Key: "ping_timeout", Label: "客户端心跳超时（毫秒，-1 使用默认值）", Type: "integer", Minimum: -1, Maximum: 2147483647},
	{Key: "fec_percentage", Label: "前向纠错冗余（%）", Type: "integer", Minimum: 1, Maximum: 255},
	{Key: "packetsize", Label: "视频分包上限（字节，0 使用协商值，或 200–65535）", Type: "integer", Maximum: 65535},
	{Key: "lan_encryption_mode", Label: "局域网加密（0 禁用，1 可选，2 强制）", Type: "integer", Maximum: 2},
	{Key: "wan_encryption_mode", Label: "广域网加密（0 禁用，1 可选，2 强制）", Type: "integer", Maximum: 2},
	{Key: "mouse", Label: "鼠标输入", Type: "boolean"},
	{Key: "keyboard", Label: "键盘输入", Type: "boolean"},
	{Key: "key_repeat_delay", Label: "键盘重复延迟（毫秒，0 禁用重复，-1 使用默认值）", Type: "integer", Minimum: -1, Maximum: 2147483647},
	{Key: "key_repeat_frequency", Label: "键盘重复频率（Hz，0 使用默认值）", Type: "number", Maximum: math.MaxFloat64},
	{Key: "key_rightalt_to_key_win", Label: "将右 Alt 映射为 Windows 键", Type: "boolean"},
	{Key: "controller", Label: "手柄输入", Type: "boolean"},
	{Key: "gamepad_driver", Label: "Windows 虚拟手柄驱动（all 使用可用驱动）", Type: "string", Choices: []string{"all", "virtualhid", "vigembus"}},
	{Key: "virtualhid_randomize_mac", Label: "Windows Virtual HID 手柄随机 MAC 地址", Type: "boolean"},
	{Key: "back_button_timeout", Label: "手柄返回键模拟主页键（毫秒，-1 禁用）", Type: "integer", Minimum: -1, Maximum: 2147483647},
	{Key: "ds4_back_as_touchpad_click", Label: "PlayStation 手柄返回键模拟触摸板点击", Type: "boolean"},
	{Key: "motion_as_ds4", Label: "运动传感器手柄采用 PlayStation 模拟", Type: "boolean"},
	{Key: "touchpad_as_ds4", Label: "触摸板手柄采用 PlayStation 模拟", Type: "boolean"},
	{Key: "native_pen_touch", Label: "原生触控与笔输入", Type: "boolean"},
	{Key: "high_resolution_scrolling", Label: "高精度滚动", Type: "boolean"},
	{Key: "always_send_scancodes", Label: "始终发送键盘扫描码", Type: "boolean"},
	{Key: "system_tray", Label: "系统托盘", Type: "boolean"},
	{Key: "min_log_level", Label: "日志级别", Type: "string", Choices: []string{"verbose", "debug", "info", "warning", "error", "fatal", "none", "0", "1", "2", "3", "4", "5", "6"}},
}

var encoderFieldByKey = func() map[string]encoderField {
	fields := make(map[string]encoderField, len(encoderFields))
	for _, field := range encoderFields {
		fields[field.Key] = field
	}
	return fields
}()

var encoderDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

var encoderResolution = regexp.MustCompile(`^([0-9]+)x([0-9]+)$`)
var encoderRefreshRate = regexp.MustCompile(`^([0-9]+)(?:\.([0-9]+))?$`)

// Match the native display parser's unsigned dimensions and rational refresh
// rate. Validate the rational numerator as well as its denominator, so a finite
// Go float cannot admit a value that the native uint32 representation loses.
func validEncoderDisplayValue(key, value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return true
	}
	var parts []string
	switch key {
	case "dd_manual_resolution":
		match := encoderResolution.FindStringSubmatch(value)
		if match == nil {
			return false
		}
		parts = match[1:]
	case "dd_manual_refresh_rate":
		match := encoderRefreshRate.FindStringSubmatch(value)
		if match == nil {
			return false
		}
		fraction := strings.TrimRight(match[2], "0")
		if len(fraction) > 9 {
			return false
		}
		parts = []string{match[1] + fraction}
	default:
		return true
	}
	for _, part := range parts {
		part = strings.TrimLeft(part, "0")
		if part == "" {
			part = "0"
		}
		if _, err := strconv.ParseUint(part, 10, 32); err != nil {
			return false
		}
	}
	return true
}

func validEncoderField(key string, raw json.RawMessage) bool {
	field, known := encoderFieldByKey[key]
	if !known || string(raw) == "null" {
		return true
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	if value == nil {
		return true
	}
	text, isText := value.(string)
	// Empty overrides are removed by the native persistence API.
	if isText && text == "" {
		return true
	}
	switch field.Type {
	case "string":
		if !isText || strings.ContainsAny(text, "\r\n\x00") {
			return false
		}
		if !validEncoderDisplayValue(key, text) {
			return false
		}
		if len(field.Choices) == 0 {
			return true
		}
		for _, choice := range field.Choices {
			if text == choice {
				return true
			}
		}
		return false
	case "boolean":
		if _, ok := value.(bool); ok {
			return true
		}
		if !isText {
			return false
		}
		switch text {
		case "true", "false", "yes", "no", "enable", "enabled", "disable", "disabled", "on", "off", "1", "0":
			return true
		}
	case "integer":
		if !isText {
			text = string(raw)
		}
		n, err := strconv.ParseInt(text, 10, 32)
		if err != nil || float64(n) < field.Minimum || float64(n) > field.Maximum {
			return false
		}
		// config.cpp accepts zero to retain client negotiation. rtsp.cpp rejects
		// positive limits below PACKETSIZE_MIN; reject them before persistence.
		if key == "packetsize" && n != 0 && n < 200 {
			return false
		}
		if len(field.Choices) == 0 {
			return true
		}
		for _, choice := range field.Choices {
			if strconv.FormatInt(n, 10) == choice {
				return true
			}
		}
		return false
	case "number":
		if !isText {
			text = string(raw)
		}
		n, err := strconv.ParseFloat(text, 64)
		return encoderDecimal.MatchString(text) && err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= field.Minimum && n <= field.Maximum
	}
	return false
}

package handlers

import (
	"encoding/json"
	"strconv"
	"strings"
)

// These reviewed fields mirror src/config.cpp in the vendored encoder.
// The catalog describes editable overrides, not platform-dependent defaults.
type encoderField struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Type    string   `json:"type"`
	Minimum int64    `json:"minimum,omitempty"`
	Maximum int64    `json:"maximum,omitempty"`
	Choices []string `json:"choices,omitempty"`
}

var encoderFields = []encoderField{
	{Key: "sunshine_name", Label: "渲染节点名称", Type: "string"},
	{Key: "capture", Label: "画面采集方式", Type: "string"},
	{Key: "encoder", Label: "编码器", Type: "string"},
	{Key: "adapter_name", Label: "显卡", Type: "string"},
	{Key: "output_name", Label: "显示输出", Type: "string"},
	{Key: "audio_sink", Label: "主机声音设备", Type: "string"},
	{Key: "virtual_sink", Label: "虚拟声音设备", Type: "string"},
	{Key: "stream_audio", Label: "传输主机声音", Type: "boolean"},
	{Key: "max_bitrate", Label: "最大码率（kbps，0 为不限制）", Type: "integer", Maximum: 2147483647},
	{Key: "hevc_mode", Label: "HEVC 支持模式（0 自动，1 禁用，2 主档次，3 含 Main10）", Type: "integer", Maximum: 3},
	{Key: "av1_mode", Label: "AV1 支持模式（0 自动，1 禁用，2 8 位，3 含 10 位）", Type: "integer", Maximum: 3},
	{Key: "nvenc_preset", Label: "NVIDIA 编码预设（1 最快，7 质量优先）", Type: "integer", Minimum: 1, Maximum: 7},
	{Key: "nvenc_vbv_increase", Label: "NVIDIA VBV 缓冲增量（%）", Type: "integer", Maximum: 400},
	{Key: "nvenc_spatial_aq", Label: "NVIDIA 空间自适应量化", Type: "boolean"},
	{Key: "nvenc_h264_cavlc", Label: "NVIDIA H.264 使用 CAVLC", Type: "boolean"},
	{Key: "qsv_slow_hevc", Label: "Intel 启用较慢的 HEVC 编码器", Type: "boolean"},
	{Key: "amd_preanalysis", Label: "AMD 编码预分析", Type: "boolean"},
	{Key: "amd_vbaq", Label: "AMD 方差自适应量化", Type: "boolean"},
	{Key: "amd_enforce_hrd", Label: "AMD 强制 HRD 缓冲约束", Type: "boolean"},
	{Key: "ping_timeout", Label: "客户端心跳超时（毫秒，-1 使用默认值）", Type: "integer", Minimum: -1, Maximum: 2147483647},
	{Key: "fec_percentage", Label: "前向纠错冗余（%）", Type: "integer", Minimum: 1, Maximum: 255},
	{Key: "lan_encryption_mode", Label: "局域网加密（0 禁用，1 可选，2 强制）", Type: "integer", Maximum: 2},
	{Key: "wan_encryption_mode", Label: "广域网加密（0 禁用，1 可选，2 强制）", Type: "integer", Maximum: 2},
	{Key: "mouse", Label: "鼠标输入", Type: "boolean"},
	{Key: "keyboard", Label: "键盘输入", Type: "boolean"},
	{Key: "controller", Label: "手柄输入", Type: "boolean"},
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
		return err == nil && n >= field.Minimum && n <= field.Maximum
	}
	return false
}

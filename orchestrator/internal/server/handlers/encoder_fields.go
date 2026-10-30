package handlers

import (
	"encoding/json"
	"strconv"
	"strings"
)

// These reviewed fields mirror src/config.cpp in the vendored encoder.
// The catalog describes editable overrides, not platform-dependent defaults.
type encoderField struct {
	Key     string `json:"key"`
	Label   string `json:"label"`
	Type    string `json:"type"`
	Minimum int64  `json:"minimum,omitempty"`
	Maximum int64  `json:"maximum,omitempty"`
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
	{Key: "mouse", Label: "鼠标输入", Type: "boolean"},
	{Key: "keyboard", Label: "键盘输入", Type: "boolean"},
	{Key: "controller", Label: "手柄输入", Type: "boolean"},
	{Key: "native_pen_touch", Label: "原生触控与笔输入", Type: "boolean"},
	{Key: "high_resolution_scrolling", Label: "高精度滚动", Type: "boolean"},
	{Key: "always_send_scancodes", Label: "始终发送键盘扫描码", Type: "boolean"},
	{Key: "system_tray", Label: "系统托盘", Type: "boolean"},
	{Key: "min_log_level", Label: "日志级别", Type: "string"},
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
		return isText && !strings.ContainsAny(text, "\r\n\x00")
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

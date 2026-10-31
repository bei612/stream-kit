package config

import (
	"fmt"
	"strconv"
	"strings"
)

func ValidateWindowsSession(name string, cfg ComponentConfig) error {
	if cfg.WindowsSessionID == 0 && cfg.WindowsUserSID == "" {
		return nil
	}
	invalid := func() error {
		return fmt.Errorf("components.%s Windows 用户会话仅适用于受管 Sunshine 或媒体网关，必须同时设置有效会话 ID、用户 SID 和程序路径", name)
	}
	if (name != "sunshine" && name != "web_server") || cfg.ExePath == "" || cfg.WindowsSessionID == 0 || cfg.WindowsSessionID == ^uint32(0) {
		return invalid()
	}
	parts := strings.Split(cfg.WindowsUserSID, "-")
	if len(parts) < 4 || len(parts) > 18 || parts[0] != "S" || parts[1] != "1" {
		return invalid()
	}
	for i, part := range parts[2:] {
		bits := 32
		if i == 0 {
			bits = 48
		}
		value, err := strconv.ParseUint(part, 10, bits)
		if err != nil || strconv.FormatUint(value, 10) != part {
			return invalid()
		}
	}
	if cfg.WindowsUserSID == "S-1-5-18" || cfg.WindowsUserSID == "S-1-5-19" || cfg.WindowsUserSID == "S-1-5-20" {
		return invalid()
	}
	return nil
}

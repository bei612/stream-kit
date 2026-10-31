package app

import (
	"errors"
	"fmt"
	"strings"
)

var ErrInvalidLaunchArguments = errors.New("启动参数配置无效")

// resolveArguments applies the same template precedence and bounds to imported,
// local and edited applications. Clearing a template retains the supplied args.
func (m *Manager) resolveArguments(args, template string) (string, error) {
	validate := func(value string) error {
		if len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("%w：参数不能超过 4096 字节或包含换行、NUL", ErrInvalidLaunchArguments)
		}
		return nil
	}
	if err := validate(args); err != nil {
		return "", err
	}
	if template != "" {
		value, ok := m.config.Templates[template]
		if !ok {
			return "", fmt.Errorf("%w：启动模板不存在", ErrInvalidLaunchArguments)
		}
		args = value
	}
	if err := validate(args); err != nil {
		return "", err
	}
	return args, nil
}

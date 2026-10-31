// Package commandline defines the shared shell-free component argument grammar.
package commandline

import (
	"fmt"
	"strings"
	"unicode"
)

// Parse parses the same shell-free argument grammar on every platform.
// Quotes group text (including empty values); backslashes stay literal so
// Windows paths survive unchanged. No environment or shell expansion occurs.
func Parse(s string) ([]string, error) {
	var args []string
	var cur strings.Builder
	inSingle, inDouble := false, false
	started := false
	for _, r := range s {
		switch {
		case r == 0:
			return nil, fmt.Errorf("组件参数不能包含空字符")
		case r == '\'' && !inDouble:
			inSingle = !inSingle
			started = true
		case r == '"' && !inSingle:
			inDouble = !inDouble
			started = true
		case unicode.IsSpace(r) && !inSingle && !inDouble:
			if started {
				args = append(args, cur.String())
				cur.Reset()
				started = false
			}
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	if inSingle || inDouble {
		return nil, fmt.Errorf("组件参数引号未闭合")
	}
	if started {
		args = append(args, cur.String())
	}
	return args, nil
}

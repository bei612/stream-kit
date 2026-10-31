package app

import (
	"bufio"
	"debug/elf"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Program format policy is shared by local registration, archive discovery and
// explicit entry selection. Discovery never changes permissions or executes it.
func inspectProgram(file *os.File, platform string) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("入口必须为可读的普通文件")
	}
	var magic [4]byte
	n, err := file.ReadAt(magic[:], 0)
	if err != nil && err != io.EOF {
		return err
	}
	switch platform {
	case "windows":
		if !strings.EqualFold(filepath.Ext(file.Name()), ".exe") || n < 2 || magic[0] != 'M' || magic[1] != 'Z' {
			return fmt.Errorf("Windows 入口必须为 PE 可执行文件")
		}
		return nil
	case "linux":
		if n >= 4 && string(magic[:]) == "\x7fELF" {
			binary, err := elf.NewFile(file)
			if err != nil {
				return fmt.Errorf("ELF 文件无效: %w", err)
			}
			machine := map[string]elf.Machine{"amd64": elf.EM_X86_64, "arm64": elf.EM_AARCH64}[runtime.GOARCH]
			if machine == elf.EM_NONE || binary.Machine != machine || (binary.Type != elf.ET_EXEC && binary.Type != elf.ET_DYN) || binary.Entry == 0 {
				return fmt.Errorf("入口不是当前服务器架构的 ELF 程序")
			}
			return nil
		}
		if n >= 2 && magic[0] == '#' && magic[1] == '!' {
			line, err := bufio.NewReader(io.NewSectionReader(file, 0, 4096)).ReadString('\n')
			if (err != nil && err != io.EOF) || strings.ContainsAny(line, "\x00\r") {
				return fmt.Errorf("启动脚本需要有效的 Unix shebang 首行")
			}
			fields := strings.Fields(strings.TrimPrefix(line, "#!"))
			if len(fields) == 0 || !filepath.IsAbs(fields[0]) {
				return fmt.Errorf("启动脚本必须指定绝对路径的解释器")
			}
			interpreter, err := os.Stat(fields[0])
			if err != nil || !interpreter.Mode().IsRegular() || interpreter.Mode().Perm()&0111 == 0 {
				return fmt.Errorf("启动脚本的解释器不存在或不可执行")
			}
			return nil
		}
		return fmt.Errorf("Linux 入口必须为 ELF 程序或带 shebang 的启动脚本")
	default:
		return fmt.Errorf("不支持的服务器平台: %s", platform)
	}
}

func resolveUploadedProgram(appDir, relative string, prepare bool) (string, string, error) {
	name := strings.ReplaceAll(relative, `\`, "/")
	if err := validateEntryName(name); err != nil {
		return "", "", err
	}
	root, err := os.OpenRoot(appDir)
	if err != nil {
		return "", "", err
	}
	defer root.Close()
	relative = filepath.FromSlash(name)
	entry, err := root.Lstat(relative)
	if err != nil || !entry.Mode().IsRegular() {
		return "", "", fmt.Errorf("入口必须为解压目录内的普通文件，不能是链接或设备")
	}
	file, err := root.Open(relative)
	if err != nil {
		return "", "", fmt.Errorf("入口不在解压目录内或无法读取: %w", err)
	}
	defer file.Close()
	if err := inspectProgram(file, runtime.GOOS); err != nil {
		return "", "", err
	}
	if prepare && runtime.GOOS == "linux" {
		// Windows-created ZIPs often lack Unix execute bits. Grant execution only
		// to the chosen, format-validated, platform-owned entry; never local files.
		info, err := file.Stat()
		if err != nil {
			return "", "", err
		}
		if info.Mode().Perm()&0100 == 0 {
			if err := file.Chmod(info.Mode().Perm() | 0100); err != nil {
				return "", "", err
			}
		}
	}
	return filepath.Join(appDir, relative), relative, nil
}

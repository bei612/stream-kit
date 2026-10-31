package deployment

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// Linux setup runs as the same non-root user that owns rendering and audio.
func CurrentRenderIdentity() (uint32, string, error) { return 0, "", nil }

func validateSetupIdentity(options Options) error {
	if options.SessionID != 0 || options.UserSID != "" {
		return fmt.Errorf("Windows session/SID options are not valid on Linux")
	}
	if os.Getuid() == 0 || os.Geteuid() == 0 || os.Getuid() != os.Geteuid() {
		return fmt.Errorf("initialize Linux platform as the non-root rendering user")
	}
	return nil
}

func validateSetupParent(parent string) error {
	for directory := parent; ; directory = filepath.Dir(directory) {
		info, err := os.Lstat(directory)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		// Root-owned sticky ancestors (such as /tmp) protect children owned by
		// this user. The immediate data parent itself must remain non-shared.
		stickyAncestor := ok && directory != parent && stat.Uid == 0 && info.Mode()&os.ModeSticky != 0
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) || (info.Mode().Perm()&0022 != 0 && !stickyAncestor) {
			return fmt.Errorf("Linux data ancestors must protect the rendering user's directory ownership")
		}
		if filepath.Dir(directory) == directory {
			break
		}
	}
	return nil
}

func protectDirectory(directory, sid string, media bool) error {
	if sid != "" {
		return fmt.Errorf("Windows SID is not valid on Linux")
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("setup directory must be owned by the rendering user and cannot be linked")
	}
	return os.Chmod(directory, 0700)
}

func publishDirectory(stage, data string) error {
	if err := unix.Renameat2(unix.AT_FDCWD, stage, unix.AT_FDCWD, data, unix.RENAME_NOREPLACE); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(data))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

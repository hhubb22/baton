//go:build !windows

package privatefile

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func checkPath(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("秘密文件不是普通文件")
	}
	return nil
}

// Open 在同一文件描述符上检查权限并读取，不跟随符号链接。
func Open(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0) {
		err = errors.New("秘密文件无效或权限过宽")
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func CreateTemp(dir, prefix string) (*os.File, error) {
	return os.CreateTemp(dir, prefix+"*")
}

func ProtectDir(path string) error {
	return os.Chmod(path, 0o700)
}

func CheckDir(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("秘密目录无效或权限过宽")
	}
	return nil
}

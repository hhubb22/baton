//go:build unix

package fileaccess

import (
	"errors"
	"os"
	"syscall"
)

// 套接字等无法 open 的特殊文件在失败后按当前类型返回拒绝，避免只根据打开前的检查放行。
func openInRoot(root *os.Root, rel string) (*os.File, error) {
	file, err := root.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	// 打开套接字时 Linux 返回 ENXIO，macOS 返回 EOPNOTSUPP。
	if err == nil || !(errors.Is(err, syscall.ENXIO) || errors.Is(err, syscall.EOPNOTSUPP)) {
		return file, err
	}
	info, statErr := root.Lstat(rel)
	if statErr == nil && isSpecialMode(info.Mode()) {
		return nil, errSpecialFile
	}
	return nil, err
}

func isSpecialMode(mode os.FileMode) bool {
	if mode&os.ModeSymlink != 0 {
		return false
	}
	return mode&os.ModeNamedPipe != 0 || mode&os.ModeSocket != 0 || mode&os.ModeDevice != 0 || mode&os.ModeIrregular != 0
}

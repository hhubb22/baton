//go:build unix

package fileaccess

import (
	"errors"
	"os"
	"syscall"
)

// openInRoot 以非阻塞方式打开授权目录内的目标。
// 命名管道在没有对端时，普通只读打开会一直等待；调用方拿到描述符后立刻检查类型。
// 套接字等无法 open 的特殊文件在失败后按当前类型返回拒绝，避免只根据打开前的检查放行。
func openInRoot(root *os.Root, rel string) (*os.File, error) {
	name := rel
	if name == "" {
		name = "."
	}
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	// 打开套接字时 Linux 返回 ENXIO，macOS 返回 EOPNOTSUPP。
	if err == nil || !(errors.Is(err, syscall.ENXIO) || errors.Is(err, syscall.EOPNOTSUPP)) {
		return file, err
	}
	info, statErr := root.Lstat(name)
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

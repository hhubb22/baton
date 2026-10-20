// Package privatefile 限制本地秘密文件为当前用户访问。
package privatefile

import (
	"io"
	"os"
	"path/filepath"
)

func ReadFile(path string) ([]byte, error) {
	f, err := Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// ReadSnapshot 读取已打开的文件版本，允许其他进程原子替换路径。
func ReadSnapshot(path string) ([]byte, error) {
	f, err := OpenSnapshot(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// WriteFile 在受限临时文件中写入、同步，再原子替换目标；POSIX 同时同步父目录。
func WriteFile(path string, data []byte) error {
	return writeFile(path, data, syncParent)
}

func writeFile(path string, data []byte, syncDirectory func(string) error) error {
	if err := checkPath(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	f, err := CreateTemp(filepath.Dir(path), ".private-")
	if err != nil {
		return err
	}
	defer f.Close()
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := replaceFile(f.Name(), path); err != nil {
		return err
	}
	return syncDirectory(path)
}

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

// WriteFile 在受限临时文件中写入，再原子替换目标。
func WriteFile(path string, data []byte) error {
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
	return os.Rename(f.Name(), path)
}

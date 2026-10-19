package sidecar

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"baton/internal/privatefile"
)

// PrivateFile 供 Node sidecar 使用相同的原生 ACL 与原子替换实现。
// 凭据只经子进程管道传递，错误使用固定文本。
func PrivateFile(args []string, input io.Reader, output io.Writer) error {
	if len(args) < 2 {
		return errors.New("sidecar 文件参数无效")
	}
	operation, dir := args[0], args[1]
	if operation == "protect-dir" && len(args) == 2 {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if err := privatefile.ProtectDir(dir); err != nil {
			return err
		}
		return privatefile.CheckDir(dir)
	}
	if len(args) != 3 || filepath.Dir(args[2]) != filepath.Clean(dir) {
		return errors.New("sidecar 文件参数无效")
	}
	if err := privatefile.CheckDir(dir); err != nil {
		return err
	}
	switch operation {
	case "read":
		file, err := privatefile.OpenSnapshot(args[2])
		if err != nil {
			return err
		}
		defer file.Close()
		raw, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
		if err != nil {
			return err
		}
		if len(raw) > 64<<10 {
			return errors.New("sidecar 凭据超过容量")
		}
		_, err = output.Write(raw)
		return err
	case "write":
		raw, err := io.ReadAll(io.LimitReader(input, (64<<10)+1))
		if err != nil {
			return err
		}
		if len(raw) > 64<<10 {
			return errors.New("sidecar 凭据超过容量")
		}
		return privatefile.WriteFile(args[2], raw)
	}
	return errors.New("sidecar 文件操作无效")
}

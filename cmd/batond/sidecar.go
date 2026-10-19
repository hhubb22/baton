package main

import (
	"baton/internal/sidecar"
	"errors"
	"io"
	"os"
)

func cmdSidecarFile(args []string, stdout io.Writer) error {
	err := sidecar.PrivateFile(args, os.Stdin, stdout)
	if errors.Is(err, os.ErrNotExist) {
		return &exitCode{code: 3, err: errors.New("sidecar 凭据不存在")}
	}
	if err != nil {
		return errors.New("sidecar 私有文件操作失败")
	}
	return nil
}

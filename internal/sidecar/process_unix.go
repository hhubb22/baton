//go:build !windows

package sidecar

import (
	"os"
	"os/exec"
	"syscall"
)

// 守护进程读取独立管道；batond 崩溃时写端由内核关闭，整个运行进程组随即停止。
func StartTree(cmd *exec.Cmd) (func(), error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	binary, args := cmd.Path, cmd.Args
	cmd.Path = "/bin/sh"
	cmd.Args = append([]string{"sh", "-c", `(read ignored <&3; kill -KILL -$$) & watcher=$!; "$@" 3<&-; code=$?; kill "$watcher" 2>/dev/null; exit "$code"`, "baton-runtime", binary}, args[1:]...)
	cmd.ExtraFiles = []*os.File{reader}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return nil, err
	}
	reader.Close()
	return func() { writer.Close(); _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }, nil
}

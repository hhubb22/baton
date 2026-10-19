package node

import (
	"baton/internal/projectexec"
	"baton/internal/protocol"
)

const runtimeExecFile = projectexec.FileName

func DefaultProjectShell() string { return projectexec.DefaultProjectShell() }
func ReadProjectExec(dir string) (protocol.RuntimeExec, error) {
	return projectexec.ReadProjectExec(dir)
}

// WriteProjectExec 原子保存本机开关；报告循环会重新读取，不需要重启连接。
func WriteProjectExec(dir string, cfg protocol.RuntimeExec) error {
	return projectexec.WriteProjectExec(dir, cfg)
}

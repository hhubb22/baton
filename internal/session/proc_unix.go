//go:build !windows

package session

import (
	"os/exec"
	"syscall"
)

func startWorkerProcess(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

func holdAgentJob() (func(), error) {
	return func() {}, nil
}

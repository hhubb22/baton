//go:build !windows

package gateway_test

import (
	"os"
	"syscall"
)

func processAlive(pid int) error {
	if pid <= 0 {
		return os.ErrProcessDone
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	defer process.Release()
	return process.Signal(syscall.Signal(0))
}

func terminateProcess(process *os.Process) error {
	return process.Signal(syscall.SIGTERM)
}

//go:build !windows

package gateway_test

import (
	"context"
	"os"
	"syscall"
	"time"
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

func stopWorker(pid int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = stopWorkerContext(ctx, pid)
}

func stopWorkerContext(ctx context.Context, pid int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if pid <= 0 {
		return os.ErrProcessDone
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	defer process.Release()
	return process.Kill()
}

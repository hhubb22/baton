//go:build windows

package relay_test

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func processAlive(pid int) error {
	if pid <= 0 {
		return os.ErrProcessDone
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	// 进程退出码可以是 STILL_ACTIVE；进程句柄是否触发才是退出证据。
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return err
	}
	switch status {
	case uint32(windows.WAIT_TIMEOUT):
		return nil
	case windows.WAIT_OBJECT_0:
		return os.ErrProcessDone
	default:
		return fmt.Errorf("无法探测进程 %d: wait status %d", pid, status)
	}
}

func terminateProcess(process *os.Process) error {
	return process.Kill()
}

//go:build windows

package gateway_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

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

func TestStopWorkerRejectsUnrelatedExecutable(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "unrelated.exe")
	if err := os.WriteFile(other, raw, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(other, "-test.run=^TestGatewayProcessHelper$", "--", "baton-idle-process", "0")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	buf := &lockedBuf{}
	cmd.Stdout, cmd.Stderr = buf, buf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &running{cmd: cmd, out: buf}
	t.Cleanup(func() { p.stop(); _ = input.Close() })
	waitLog(t, p, "idle_process_ready")
	stopWorker(cmd.Process.Pid)
	if err := processAlive(cmd.Process.Pid); err != nil {
		t.Fatalf("旧 Worker PID 指向无关可执行文件时仍结束了进程: %v", err)
	}
}

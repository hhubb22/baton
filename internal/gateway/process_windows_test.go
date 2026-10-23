//go:build windows

package gateway_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	name := make([]uint16, 32768)
	size := uint32(len(name))
	if err := windows.QueryFullProcessImageName(handle, 0, &name[0], &size); err != nil {
		return err
	}
	image := windows.UTF16ToString(name[:size])
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	allowed := sameExecutable(image, exe)
	processMu.Lock()
	for _, handles := range processHandles {
		for _, p := range handles {
			if len(p.cmd.Args) > 1 && p.cmd.Args[1] == "run" && sameExecutable(image, p.bin) {
				allowed = true
				break
			}
		}
	}
	processMu.Unlock()
	fmt.Fprintf(os.Stderr, "event=test_worker_stop pid=%d image=%q allowed=%t\n", pid, image, allowed)
	if !allowed {
		return fmt.Errorf("拒绝终止未登记的 Worker 可执行文件: %s", image)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// 校验、终止和等待共用句柄，PID 在此期间被复用也不会指向另一个进程。
	err = windows.TerminateProcess(handle, 1)
	fmt.Fprintf(os.Stderr, "event=test_worker_terminated pid=%d error=%v\n", pid, err)
	if err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		wait := 50 * time.Millisecond
		if deadline, ok := ctx.Deadline(); ok {
			if remaining := time.Until(deadline); remaining < wait {
				wait = remaining
			}
		}
		if wait <= 0 {
			return context.DeadlineExceeded
		}
		status, err := windows.WaitForSingleObject(handle, uint32((wait+time.Millisecond-1)/time.Millisecond))
		if err != nil {
			return err
		}
		switch status {
		case windows.WAIT_OBJECT_0:
			return nil
		case uint32(windows.WAIT_TIMEOUT):
		default:
			return fmt.Errorf("无法等待 Worker %d 退出: wait status %d", pid, status)
		}
	}
}

func sameExecutable(a, b string) bool {
	a, err := filepath.Abs(a)
	if err != nil {
		return false
	}
	b, err = filepath.Abs(b)
	if err != nil {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(a); err == nil {
		a = resolved
	}
	if resolved, err := filepath.EvalSymlinks(b); err == nil {
		b = resolved
	}
	return strings.EqualFold(a, b)
}

func TestStopWorkerRejectsUnrelatedExecutable(t *testing.T) {
	t.Parallel()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "batond.exe")
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

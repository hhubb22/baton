//go:build windows

package sidecar

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestResumeThreadChild(t *testing.T) {
	if os.Getenv("BATON_TEST_RESUME_CHILD") != "1" {
		return
	}
	os.Exit(0)
}

// 把未挂起的本进程线程放在快照最前面，验证它不会被当成已恢复的子进程主线程。
func TestResumeSkipsRunningThreadBeforeSuspendedChild(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestResumeThreadChild$")
	cmd.Env = append(os.Environ(), "BATON_TEST_RESUME_CHILD=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	if err = windows.Thread32First(snapshot, &entry); err != nil {
		t.Fatal(err)
	}
	ids := []uint32{windows.GetCurrentThreadId()}
	for {
		if entry.OwnerProcessID == uint32(cmd.Process.Pid) {
			ids = append(ids, entry.ThreadID)
		}
		if windows.Thread32Next(snapshot, &entry) != nil {
			break
		}
	}
	if len(ids) < 2 {
		t.Fatal("未找到挂起的子进程线程")
	}
	if err = resumeSuspendedThread(ids); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		<-done
		t.Fatal("未挂起线程被误判为子进程已恢复")
	}
}

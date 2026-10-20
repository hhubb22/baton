//go:build windows

package sidecar

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const processTreeWindowsHelperMode = "BATON_TEST_PROCESS_TREE_WINDOWS_MODE"
const processTreeWindowsHelperPath = "BATON_TEST_PROCESS_TREE_WINDOWS_PATH"

// 辅助进程只记录自己的PID；parent持有Job，tree再派生一个leaf以验证整组清理。
func TestProcessTreeWindowsNativeHelper(t *testing.T) {
	mode := os.Getenv(processTreeWindowsHelperMode)
	if mode == "" {
		return
	}
	path := os.Getenv(processTreeWindowsHelperPath)
	recordError := func(err error) { _ = os.WriteFile(path+".error", []byte(err.Error()), 0600); os.Exit(2) }
	switch mode {
	case "parent":
		cmd := processTreeWindowsCommand(path, "tree")
		stop, err := StartTree(cmd)
		if err != nil {
			recordError(err)
		}
		defer stop()
	case "tree":
		cmd := processTreeWindowsCommand(path, "leaf")
		if err := cmd.Start(); err != nil {
			recordError(err)
		}
		if err := os.WriteFile(path+".tree", []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			recordError(err)
		}
	case "leaf":
		if err := os.WriteFile(path+".leaf", []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			recordError(err)
		}
	default:
		recordError(fmt.Errorf("未知测试进程模式 %q", mode))
	}
	for {
		time.Sleep(time.Second)
	}
}

func processTreeWindowsCommand(path, mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessTreeWindowsNativeHelper$")
	cmd.Env = append(os.Environ(), processTreeWindowsHelperMode+"="+mode, processTreeWindowsHelperPath+"="+path)
	return cmd
}

func processTreeWindowsProcess(t *testing.T, path, suffix string) windows.Handle {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if raw, err := os.ReadFile(path + ".error"); err == nil {
			t.Fatalf("Windows辅助进程失败: %s", raw)
		}
		if raw, err := os.ReadFile(path + suffix); err == nil {
			pid, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 32)
			if err == nil {
				handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
				if err != nil {
					t.Fatalf("打开%s进程: %v", suffix, err)
				}
				t.Cleanup(func() { _ = windows.CloseHandle(handle) })
				return handle
			}
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatalf("Windows%s进程没有运行并写入PID", suffix)
		}
	}
}

func processTreeWindowsExited(t *testing.T, handle windows.Handle, name string) {
	t.Helper()
	status, err := windows.WaitForSingleObject(handle, 5000)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("%s未随Job清理: status=%d err=%v", name, status, err)
	}
}

func TestProcessTreeWindowsNativeJobStartsAndStopsProcessTree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "process")
	cmd := processTreeWindowsCommand(path, "tree")
	stop, err := StartTree(cmd)
	if err != nil {
		t.Fatalf("Windows原生进程树启动失败: %v", err)
	}
	stop = sync.OnceFunc(stop)
	defer stop()
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	tree := processTreeWindowsProcess(t, path, ".tree")
	leaf := processTreeWindowsProcess(t, path, ".leaf")
	stop()
	processTreeWindowsExited(t, tree, "进程树")
	processTreeWindowsExited(t, leaf, "进程树子进程")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("进程树停止后Wait未返回")
	}
}

func TestProcessTreeWindowsJobStopsProcessTreeAfterDaemonCrash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "process")
	daemon := processTreeWindowsCommand(path, "parent")
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = daemon.Wait(); close(done) }()
	defer daemon.Process.Kill()
	tree := processTreeWindowsProcess(t, path, ".tree")
	leaf := processTreeWindowsProcess(t, path, ".leaf")
	if err := daemon.Process.Kill(); err != nil {
		t.Fatalf("停止父进程替身: %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("父进程替身被杀后Wait未返回")
	}
	processTreeWindowsExited(t, tree, "进程树")
	processTreeWindowsExited(t, leaf, "进程树子进程")
}

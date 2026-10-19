//go:build windows

package node

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

const projectRuntimeWindowsHelperMode = "BATON_TEST_PROJECT_RUNTIME_WINDOWS_MODE"
const projectRuntimeWindowsHelperPath = "BATON_TEST_PROJECT_RUNTIME_WINDOWS_PATH"

// 辅助进程只记录自己的PID；parent持有Job，tree再派生一个leaf以验证整组清理。
func TestProjectRuntimeWindowsNativeHelper(t *testing.T) {
	mode := os.Getenv(projectRuntimeWindowsHelperMode)
	if mode == "" {
		return
	}
	path := os.Getenv(projectRuntimeWindowsHelperPath)
	recordError := func(err error) { _ = os.WriteFile(path+".error", []byte(err.Error()), 0600); os.Exit(2) }
	switch mode {
	case "parent":
		cmd := projectRuntimeWindowsCommand(path, "tree")
		stop, err := startProjectRuntimeProcess(cmd)
		if err != nil {
			recordError(err)
		}
		defer stop()
	case "tree":
		cmd := projectRuntimeWindowsCommand(path, "leaf")
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

func projectRuntimeWindowsCommand(path, mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^TestProjectRuntimeWindowsNativeHelper$")
	cmd.Env = append(os.Environ(), projectRuntimeWindowsHelperMode+"="+mode, projectRuntimeWindowsHelperPath+"="+path)
	return cmd
}

func projectRuntimeWindowsProcess(t *testing.T, path, suffix string) windows.Handle {
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

func projectRuntimeWindowsExited(t *testing.T, handle windows.Handle, name string) {
	t.Helper()
	status, err := windows.WaitForSingleObject(handle, 5000)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("%s未随Job清理: status=%d err=%v", name, status, err)
	}
}

func TestProjectRuntimeWindowsNativeJobStartsAndStopsProcessTree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "process")
	cmd := projectRuntimeWindowsCommand(path, "tree")
	stop, err := startProjectRuntimeProcess(cmd)
	if err != nil {
		t.Fatalf("Windows原生Runtime启动失败: %v", err)
	}
	stop = sync.OnceFunc(stop)
	defer stop()
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	tree := projectRuntimeWindowsProcess(t, path, ".tree")
	leaf := projectRuntimeWindowsProcess(t, path, ".leaf")
	stop()
	projectRuntimeWindowsExited(t, tree, "Runtime")
	projectRuntimeWindowsExited(t, leaf, "Runtime子进程")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Runtime停止后Wait未返回")
	}
}

func TestProjectRuntimeWindowsJobStopsProcessTreeAfterDaemonCrash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "process")
	daemon := projectRuntimeWindowsCommand(path, "parent")
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = daemon.Wait(); close(done) }()
	defer daemon.Process.Kill()
	tree := projectRuntimeWindowsProcess(t, path, ".tree")
	leaf := projectRuntimeWindowsProcess(t, path, ".leaf")
	if err := daemon.Process.Kill(); err != nil {
		t.Fatalf("停止batond替身: %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("batond替身被杀后Wait未返回")
	}
	projectRuntimeWindowsExited(t, tree, "Runtime")
	projectRuntimeWindowsExited(t, leaf, "Runtime子进程")
}

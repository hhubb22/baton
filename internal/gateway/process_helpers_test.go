package gateway_test

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func TestGatewayProcessHelper(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "baton-idle-process" {
		return
	}
	code, err := strconv.Atoi(os.Args[len(os.Args)-1])
	if err != nil {
		t.Fatal(err)
	}
	if path := os.Getenv("BATON_TEST_HELD_FILE"); path != "" {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
	}
	fmt.Println("idle_process_ready")
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(code)
}

func startIdleProcess(t *testing.T, exitCode int) (*running, io.WriteCloser) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestGatewayProcessHelper$", "--", "baton-idle-process", strconv.Itoa(exitCode))
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	buf := &lockedBuf{}
	cmd.Stdout, cmd.Stderr = buf, buf
	if err := cmd.Start(); err != nil {
		input.Close()
		t.Fatal(err)
	}
	process := &running{cmd: cmd, out: buf}
	t.Cleanup(func() {
		process.stop()
		input.Close()
	})
	waitLog(t, process, "idle_process_ready")
	return process, input
}

func TestProcessAliveAndCleanup(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if err := processAlive(pid); err == nil {
			t.Fatalf("无效 PID %d 被判为存活", pid)
		}
		stopWorker(pid)
	}
	for _, code := range []int{0, 259} {
		t.Run("exit_"+strconv.Itoa(code), func(t *testing.T) {
			process, input := startIdleProcess(t, code)
			pid := process.cmd.Process.Pid
			if err := processAlive(pid); err != nil {
				t.Fatalf("存活进程未被识别: %v", err)
			}
			handle, err := os.FindProcess(pid)
			if err != nil {
				t.Fatal(err)
			}
			defer handle.Release()
			if err := input.Close(); err != nil {
				t.Fatal(err)
			}
			process.waitExit(t, 10*time.Second)
			wantCode := code
			if runtime.GOOS != "windows" {
				wantCode %= 256
			}
			if got := process.cmd.ProcessState.ExitCode(); got != wantCode {
				t.Fatalf("退出码是 %d，期望 %d", got, wantCode)
			}
			if err := processAlive(pid); err == nil {
				t.Fatal("已退出进程被判为存活")
			}
		})
	}
	for _, stop := range []string{"worker", "command"} {
		t.Run(stop, func(t *testing.T) {
			process, _ := startIdleProcess(t, 0)
			pid := process.cmd.Process.Pid
			if stop == "worker" {
				stopWorker(pid)
			} else {
				process.stop()
			}
			process.waitExit(t, 10*time.Second)
			if err := processAlive(pid); err == nil {
				t.Fatal("清理后进程仍存活")
			}
		})
	}
}

func TestPrivatePostgresProcessLifecycle(t *testing.T) {
	postgres := startPrivatePostgres(t)
	postgres.stop(t)
	postgres.start(t)
}

func TestStopWorkerWaitsForFileRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "held-file")
	t.Setenv("BATON_TEST_HELD_FILE", path)
	process, _ := startIdleProcess(t, 0)
	stopWorker(process.cmd.Process.Pid)
	if err := os.Rename(path, path+".released"); err != nil {
		t.Fatalf("进程退出后文件仍被占用: %v", err)
	}
	process.waitExit(t, 10*time.Second)
}

//go:build !windows

package gateway_test

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"baton/internal/agent/pi/pireplaytest"
)

func TestReplayPIDsMatchExecutablePath(t *testing.T) {
	t.Parallel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	start := func() (*running, io.WriteCloser) {
		t.Helper()
		dir := pireplaytest.Canonical(t, filepath.Join(t.TempDir(), "replay host"))
		binary := filepath.Join(dir, "pi-replay.exe")
		if err := os.WriteFile(binary, raw, 0700); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(binary, "-test.run=^TestGatewayProcessHelper$", "--", "baton-idle-process", "0")
		input, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		logs := &lockedBuf{}
		cmd.Stdout, cmd.Stderr = logs, logs
		if err := cmd.Start(); err != nil {
			input.Close()
			t.Fatal(err)
		}
		process := &running{cmd: cmd, out: logs, bin: binary}
		trackProcess(t, process)
		t.Cleanup(func() {
			process.stop()
			input.Close()
		})
		waitLog(t, process, "idle_process_ready")
		return process, input
	}
	first, input := start()
	second, _ := start()
	for _, process := range []*running{first, second} {
		want := []int{process.cmd.Process.Pid}
		if got := replayPIDs(t, process.bin); !slices.Equal(got, want) {
			t.Fatalf("可执行文件 %s 的进程是 %v，期望 %v；同名进程必须按完整路径区分", process.bin, got, want)
		}
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	first.waitExit(t, 5*time.Second)
	if got := replayPIDs(t, first.bin); len(got) != 0 {
		t.Fatalf("已退出的进程仍被识别为存活: %v", got)
	}
	if got := replayPIDs(t, second.bin); !slices.Equal(got, []int{second.cmd.Process.Pid}) {
		t.Fatalf("另一个同名进程受到影响: %v", got)
	}
}

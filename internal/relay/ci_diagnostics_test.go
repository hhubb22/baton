package relay_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/agent/pi"
)

// 只导出运行日志与进程信息；身份、账本和原生历史不进入诊断材料。
func diagnosticWriter(t *testing.T, bin string, args, env []string, memory io.Writer) io.Writer {
	dir := os.Getenv("BATON_TEST_DIAGNOSTICS_DIR")
	if dir == "" {
		return memory
	}
	dir = filepath.Join(dir, strings.ReplaceAll(t.Name(), "/", "_"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.CreateTemp(dir, filepath.Base(bin)+"-*.log")
	if err != nil {
		t.Fatal(err)
	}
	// 在进程清理之后关闭文件，保留退出和清理阶段输出。
	writer := &scrubWriter{file: file, env: env}
	t.Cleanup(func() {
		if err := writer.Close(); err != nil {
			t.Error(err)
		}
	})
	return io.MultiWriter(memory, writer)
}

type scrubWriter struct {
	mu       sync.Mutex
	file     *os.File
	env      []string
	pending  string
	captured bool
}

func (w *scrubWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// 子进程输出可能在凭据中间分块，按整行脱敏后写入。
	w.pending += string(p)
	for {
		line, rest, ok := strings.Cut(w.pending, "\n")
		if !ok {
			break
		}
		if _, err := io.WriteString(w.file, pi.ScrubDiagnosticText(line, w.env)+"\n"); err != nil {
			return 0, err
		}

		if !w.captured && strings.Contains(line, "bind:") {
			w.captured = true
			captureBindFailure(filepath.Dir(w.file.Name()), w.env)
		}
		w.pending = rest
	}
	return len(p), nil
}

func trackDiagnosticProcess(t *testing.T, proc *running, args, env []string) {
	root := os.Getenv("BATON_TEST_DIAGNOSTICS_DIR")
	if root == "" {
		return
	}
	dir := filepath.Join(root, strings.ReplaceAll(t.Name(), "/", "_"))
	done, stopped := make(chan struct{}), make(chan struct{})
	snapshot := func(phase string) {
		state := map[string]any{"pid": proc.cmd.Process.Pid, "binary": filepath.Base(proc.bin), "phase": phase, "time": time.Now().UTC()}
		raw, _ := json.Marshal(state)
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("process-%d.json", proc.cmd.Process.Pid)), raw, 0o600)
		for i, arg := range args {
			if arg != "--data-dir" || i+1 >= len(args) {
				continue
			}
			logs, _ := filepath.Glob(filepath.Join(args[i+1], "sessions", "*", "worker.log"))
			for _, path := range logs {
				raw, err := os.ReadFile(path)
				if err == nil {
					name := "worker-" + filepath.Base(filepath.Dir(path)) + ".log"
					_ = os.WriteFile(filepath.Join(dir, name), []byte(pi.ScrubDiagnosticText(string(raw), env)), 0o600)
				}
			}
		}
	}
	snapshot("运行")
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				snapshot("运行")
			}
		}
	}()
	t.Cleanup(func() {
		close(done)
		<-stopped
		snapshot("清理前")
	})
}

// 受控失败需要显式启用，CI 保留失败状态及全套诊断材料。
func TestCIDiagnosticFailure(t *testing.T) {
	if os.Getenv("BATON_CI_DIAGNOSTIC_FAILURE") != "1" {
		t.Skip("未启用受控失败")
	}
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START": "0", "BATON_TEST_EXECUTOR_SCRIPT": "success", "BATON_TEST_RESULT_GATE": gate,
	})
	acceptTask(t, st, "ci-diagnostic-failure")
	waitGateFile(t, gate, st)
	t.Log("token=ci-redaction-fixture password=ci-password-fixture")
	t.Fatal("受控失败：验证 Coordinator、Relay、Worker 日志及失败摘要")
}

func TestMain(m *testing.M) {
	code := m.Run()
	if buildDir != "" {
		_ = os.RemoveAll(buildDir)
	}
	os.Exit(code)
}

func (w *scrubWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.pending != "" {
		if _, err := io.WriteString(w.file, pi.ScrubDiagnosticText(w.pending, w.env)); err != nil {
			_ = w.file.Close()
			return err
		}
	}
	return w.file.Close()
}

func TestCIDiagnosticScrubsSplitOutput(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "diagnostic-*.log")
	if err != nil {
		t.Fatal(err)
	}
	writer := &scrubWriter{file: file, env: []string{"BATON_CONTROL_TOKEN=private-example"}}
	for _, part := range []string{"token=private-", "example\n", "password=secret-tail"} {
		if _, err := writer.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private-example") || strings.Contains(string(raw), "secret-tail") {
		t.Fatalf("诊断输出包含凭据")
	}
}

func TestCIPortAllocatorAvoidsReservedAndAssigned(t *testing.T) {
	var listener net.Listener
	var first int
	for port := 27000; port < 28000; port++ {
		var err error
		listener, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			first = port
			break
		}
	}
	if listener == nil {
		t.Fatal("没有可用的端口分配验证区间")
	}
	defer listener.Close()
	t.Setenv("BATON_TEST_PORT_MIN", strconv.Itoa(first))
	t.Setenv("BATON_TEST_PORT_MAX", strconv.Itoa(first+20))
	selected := map[int]bool{}
	defer func() {
		processMu.Lock()
		defer processMu.Unlock()
		for port := range selected {
			delete(allocatedPorts, port)
		}
	}()
	for range 5 {
		_, raw, err := net.SplitHostPort(freeAddr(t))
		if err != nil {
			t.Fatal(err)
		}
		port, err := strconv.Atoi(raw)
		if err != nil {
			t.Fatal(err)
		}
		if port <= first || port > first+20 || selected[port] {
			t.Fatalf("分配端口无效或重复：%d", port)
		}
		selected[port] = true
	}
}

func captureBindFailure(dir string, env []string) {
	command := []string{"ss", "-tanp"}
	if runtime.GOOS == "windows" {
		command = []string{"netstat", "-ano"}
	}
	if runtime.GOOS == "darwin" {
		command = []string{"lsof", "-nP", "-iTCP"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, command[0], command[1:]...).CombinedOutput()
	if err != nil {
		raw = append(raw, []byte(err.Error())...)
	}
	file, err := os.CreateTemp(dir, "bind-sockets-*.log")
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(pi.ScrubDiagnosticText(string(raw), env))
}

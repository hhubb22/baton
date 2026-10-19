package node

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestRuntimeProbeContractAndBounds(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", binary, "testdata/runtime_probe.go")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("构建 probe 契约程序失败：%v %s", err, out)
	}
	probeFile := filepath.Join(t.TempDir(), "probe.json")
	t.Setenv("PATH", dir)
	t.Setenv("BATON_TEST_PROBE_FILE", probeFile)
	for _, test := range []struct {
		raw string
		ok  bool
	}{
		{`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"available"}]}`, true},
		{`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"login_required"}]}`, true},
		{`{"version":"0.1.0","providers":[],"token":"secret"}`, false},
		{"slow", false}, {"flood", false}, {"error", false},
	} {
		if err := os.WriteFile(probeFile, []byte(test.raw), 0o600); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		p := probeProjectRuntime(context.Background())
		if (p != nil) != test.ok || time.Since(start) > 3*time.Second {
			t.Fatalf("probe 契约或耗时不正确：%+v %s", p, time.Since(start))
		}
	}
	t.Setenv("PATH", t.TempDir())
	if probeProjectRuntime(context.Background()) != nil {
		t.Fatal("未安装 Runtime 仍产生报告")
	}
}

func TestRuntimeReportDefaultsAndConfigChange(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", t.TempDir())
	r := collectRuntimeReport(context.Background(), dir)
	if r.Exec.Enabled || r.Exec.Shell == "" || r.ProjectRuntime != nil {
		t.Fatalf("默认报告错误：%+v", r)
	}
	if err := WriteProjectExec(dir, protocol.RuntimeExec{Enabled: true, Shell: "custom-shell"}); err != nil {
		t.Fatal(err)
	}
	r = collectRuntimeReport(context.Background(), dir)
	if !r.Exec.Enabled || r.Exec.Shell != "custom-shell" {
		t.Fatal("开关变化未生效")
	}
	if err := os.WriteFile(filepath.Join(dir, runtimeExecFile), []byte(`{"enabled":true,"shell":"sh","token":"secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r = collectRuntimeReport(context.Background(), dir)
	if r.Exec.Enabled || !r.Truncated {
		t.Fatal("无效配置没有关闭命令执行")
	}
	b := &probeOutput{}
	_, _ = io.Copy(b, io.LimitReader(bytes.NewBufferString(strings.Repeat("x", 1<<20)), 1<<20))
	if b.Len() != 16<<10 || !b.overflow {
		t.Fatal("probe 输出缓冲超过上限")
	}
}

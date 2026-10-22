package gateway_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestRuntimeReportRealProcesses(t *testing.T) {
	t.Parallel()
	binDir := t.TempDir()
	probeFile := filepath.Join(t.TempDir(), "probe.json")
	probeBinary := filepath.Join(binDir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		probeBinary += ".exe"
	}
	build := exec.Command("go", "build", "-o", probeBinary, "../node/testdata/runtime_probe.go")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建 probe 契约程序失败：%v %s", err, out)
	}
	writeProbe := func(raw string) {
		t.Helper()
		if err := os.WriteFile(probeFile, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeProbe(`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"available"}]}`)
	st := startThreadStack(t, map[string]string{"PATH": binDir + string(os.PathListSeparator) + os.Getenv("PATH"), "BATON_TEST_PROBE_FILE": probeFile})
	initialVersion, _ := waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime != nil && !r.Exec.Enabled })
	root := t.TempDir()
	for _, args := range [][]string{{"init", root}, {"-C", root, "remote", "add", "origin", "https://user:credential-secret@git.example/team/repo?token=query-secret"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("创建临时仓库失败：%v %s", err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "private.txt"), []byte("file-content-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	cli := func(args ...string) {
		t.Helper()
		if out, err := exec.Command(st.batondBin, args...).CombinedOutput(); err != nil {
			t.Fatalf("本机配置失败：%v %s", err, out)
		}
	}
	cli("files", "add", "--data-dir", st.dataDir, "--id", "dev", "--path", root)
	cli("project-exec", "--data-dir", st.dataDir, "--enabled=true", "--shell", "sh")
	v, report := waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.Exec.Enabled && len(r.Roots) == 1 && len(r.Repos) == 1 })
	if v <= initialVersion || report.Repos[0].Origin != "git.example/team/repo" {
		t.Fatalf("配置更新未传播：%d %+v", v, report)
	}
	writeProbe(`{"version":"0.1.0","providers":[{"provider":"openai-codex","status":"login_required"}]}`)
	v, _ = waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool {
		return r.ProjectRuntime != nil && len(r.ProjectRuntime.Providers) == 1 && r.ProjectRuntime.Providers[0].Status == "login_required"
	})
	// 慢 probe 期间，节点仍须保持连接并更新能力报告。
	writeProbe("slow")
	_, _ = waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime == nil })
	st.batond.stop()
	if err := os.Remove(probeBinary); err != nil {
		t.Fatal(err)
	}
	st.batond = startCmd(t, st.batondBin, st.batondArgs, st.batondEnv)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	v, report = waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime == nil && r.Exec.Enabled })
	var caps []string
	if err := st.pool.QueryRow(context.Background(), `SELECT capabilities FROM nodes WHERE id=$1::uuid`, st.ident.NodeID).Scan(&caps); err != nil || strings.Join(caps, ",") != "pi,codex" {
		t.Fatalf("执行 Agent 能力改变：%v %v", caps, err)
	}
	cli("project-exec", "--data-dir", st.dataDir, "--enabled=false", "--shell", "sh")
	cli("files", "remove", "--data-dir", st.dataDir, "--id", "dev")
	final, _ := waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool {
		return !r.Exec.Enabled && len(r.Roots) == 0 && len(r.Repos) == 0 && r.ProjectRuntime == nil
	})
	if final <= v {
		t.Fatal("撤销目录和命令授权未增加报告版本")
	}
	for _, log := range []string{st.batond.out.String(), st.coord.out.String()} {
		for _, secret := range []string{"credential-secret", "query-secret", "file-content-secret"} {
			if strings.Contains(log, secret) {
				t.Fatal("日志泄露了敏感内容")
			}
		}
	}
	t.Logf("真实 Coordinator、batond 验证通过；报告版本 %d → %d，probe 为契约测试程序", initialVersion, final)
}

func waitRuntimeReport(t *testing.T, st *processStack, match func(protocol.RuntimeReport) bool) (int64, protocol.RuntimeReport) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var raw []byte
		var version int64
		err := st.pool.QueryRow(context.Background(), `SELECT report_version,report::text FROM node_runtime_reports WHERE node_id=$1::uuid`, st.ident.NodeID).Scan(&version, &raw)
		if err == nil {
			if len(raw) > protocol.MaxRuntimeReportBytes {
				t.Fatal("数据库报告超过 64 KiB")
			}
			for _, secret := range []string{"credential-secret", "query-secret", "file-content-secret"} {
				if strings.Contains(string(raw), secret) {
					t.Fatal("报告泄露了敏感内容")
				}
			}
			var report protocol.RuntimeReport
			if json.Unmarshal(raw, &report) == nil && match(report) {
				return version, report
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("能力报告没有更新；Coordinator：%s；节点：%s", st.coord.out.String(), st.batond.out.String())
	return 0, protocol.RuntimeReport{}
}

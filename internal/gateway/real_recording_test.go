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

	"baton/internal/agent"
	"baton/internal/agent/replay"
	"baton/internal/task"
)

var realScenarios = []string{
	"simple", "result_free_text", "interrupt_idle", "interrupt_mid_tool",
	"interrupt_before_turn_started", "deliver_active", "deliver_idle",
	"restore_load_only", "restore_missing", "provider_error", "symlinked_workspace",
}

func realRecordingTool(t *testing.T) string {
	t.Helper()
	if os.Getenv("BATON_RECORD_DIR") == "" {
		return ""
	}
	binary := filepath.Join(t.TempDir(), "agent-replay"+realExecutableSuffix())
	cmd := exec.Command("go", "build", "-o", binary, "./tools/agent-replay")
	cmd.Dir = filepath.Join("..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("构建录制器: %v %s", err, out)
	}
	return binary
}

func realExecutableSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

type realRecording struct {
	binary string
	config *replay.RecordConfig
}

// 关闭录制时直接返回原可执行文件，不添加参数或环境变量。
func newRealRecording(t *testing.T, tool, kind, version, model, binary string, bindings map[string]string) *realRecording {
	t.Helper()
	r := &realRecording{binary: binary}
	if tool == "" {
		return r
	}
	rawDir, err := filepath.Abs(filepath.Join(os.Getenv("BATON_RECORD_DIR"), kind))
	if err != nil {
		t.Fatal(err)
	}
	scenario := filepath.Base(t.Name())
	if err := os.MkdirAll(rawDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// 每次真实运行使用新目录，防止把两个独立场景的进程追加到一起。
	if _, err := os.Lstat(filepath.Join(rawDir, scenario+".raw.ndjson")); !os.IsNotExist(err) {
		t.Fatal("场景已有原始录制，请使用新的 BATON_RECORD_DIR")
	}
	dir := t.TempDir()
	r.binary = filepath.Join(dir, "agent-record"+realExecutableSuffix())
	data, err := os.ReadFile(tool)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.binary, data, 0o700); err != nil {
		t.Fatal(err)
	}
	commit, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	protocol := "pi-rpc-jsonl"
	if kind == "codex" {
		protocol = "codex-app-server-jsonrpc"
	}
	header := replay.Header{Agent: kind, Protocol: protocol, AgentVersion: version, Platform: runtime.GOOS + "/" + runtime.GOARCH,
		Model: model, Scenario: scenario, BatonCommit: strings.TrimSpace(string(commit)), RecordedAt: time.Now().Format("2006-01-02"), Source: "local recording"}
	scenarioFile := filepath.Join(dir, "scenario.json")
	writeRealJSON(t, scenarioFile, header)
	r.config = &replay.RecordConfig{AgentBinary: binary, RawDir: rawDir, RawTempDir: os.TempDir(), ScenarioFile: scenarioFile, Bindings: bindings}
	writeRealJSON(t, r.binary+".record.json", r.config)
	return r
}

func (r *realRecording) bind(t *testing.T, key, value string) {
	t.Helper()
	if r.config == nil {
		return
	}
	r.config.Bindings[key] = value
	writeRealJSON(t, r.binary+".record.json", r.config)
}

// 录制开启时，要求工具开始帧已经落入原始记录，避免只凭工作目录里的文件就提前中止。
func (r *realRecording) waitCodexCommandStarted(t *testing.T, ctx context.Context, threadID, turnID string) {
	t.Helper()
	if r.config == nil {
		return
	}
	path := filepath.Join(r.config.RawDir, filepath.Base(t.Name())+".raw.ndjson")
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal("无法读取工具开始的录制证据", err)
		}
		if recordedCodexCommandStarted(raw, threadID, turnID) {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("录制中没有匹配回合的 commandExecution 开始事件")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func recordedCodexCommandStarted(raw []byte, threadID, turnID string) bool {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	for {
		var entry replay.RawEntry
		// 录制仍在追加，末尾不完整的 JSON 留到下一次读取。
		if decoder.Decode(&entry) != nil {
			return false
		}
		if entry.Type != "stdout" {
			continue
		}
		var frame struct {
			Method string
			Params struct {
				ThreadID, TurnID string
				Item             struct{ Type, Status string }
			}
		}
		if json.Unmarshal(entry.Data, &frame) == nil && frame.Method == "item/started" && frame.Params.ThreadID == threadID && frame.Params.TurnID == turnID && frame.Params.Item.Type == "commandExecution" && frame.Params.Item.Status == "inProgress" {
			return true
		}
	}
}

func writeRealJSON(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

func realSymlinkedWorkspace(t *testing.T, work string) string {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("此场景录制 macOS /tmp 到 /private/tmp 的路径别名")
	}
	dir, err := os.MkdirTemp("/tmp", "baton-real-symlink-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	link := filepath.Join(dir, "workspace")
	if err := os.Symlink(work, link); err != nil {
		t.Fatal(err)
	}
	return link
}

func assertRealCompleted(t *testing.T, out agent.Output, summary string) {
	t.Helper()
	candidate, err := task.ParseCandidate(out.Final)
	if err != nil || candidate.Status != task.StatusCompleted || candidate.Summary != summary || !out.Exited || out.Uncertain {
		t.Fatal("Agent 未以 settled 的结构化结果完成")
	}
}

func waitRealStop(t *testing.T, a agent.StopObserver) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	for {
		if stopped, _ := a.StopStatus(); stopped {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("中止后未观察到停止事实")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func waitRealFile(t *testing.T, ctx context.Context, path string) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Minute)
	defer deadline.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("真实测试超时")
		case <-deadline.C:
			t.Fatal("模型未到达工具门控文件")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func writeRealPiWrapper(t *testing.T, wrapper, profile, binary string) {
	t.Helper()
	script := "#!/bin/sh\nexec /usr/bin/sandbox-exec -f " + shellQuote(profile) + " " + shellQuote(binary) + " \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
}

func assertRealOnceOnlyFile(t *testing.T, work string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(work, "count.txt"))
	if err != nil || string(raw) != "one\n" {
		t.Fatal("restore changed the once-only fixture")
	}
}

package gateway_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/agent/replay"
)

var realScenarios = []string{"multi_turn", "stop", "restore_load_only", "restore_missing"}

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
	if kind == "kiro" {
		protocol = "acp-jsonrpc"
	}
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

func writeRealPiWrapper(t *testing.T, wrapper, profile, binary string) {
	t.Helper()
	script := "#!/bin/sh\nexec /usr/bin/sandbox-exec -f " + shellQuote(profile) + " " + shellQuote(binary) + " \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
}

// Package pireplaytest 为 Pi 适配器与 Worker 测试准备同一份录制转录。
package pireplaytest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/replay"
)

const Model = "google-vertex/gemini-3.1-flash-lite"

var Scenarios = []string{"startup", "simple", "result_free_text", "interrupt_idle", "interrupt_mid_tool", "interrupt_before_turn_started", "deliver_idle", "restore_load_only", "restore_missing", "restore_recall", "provider_error", "symlinked_workspace"}

func Build(t *testing.T, source string) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "agent-replay.exe")
	if out, err := exec.Command("go", "build", "-o", binary, source).CombinedOutput(); err != nil {
		t.Fatalf("编译回放 Agent: %v\n%s", err, out)
	}
	return binary
}

func Read(t *testing.T, path string) replay.Transcript {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tape, err := replay.Read(f)
	if err != nil {
		t.Fatal(err)
	}
	return tape
}

func Canonical(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

type Fixture struct {
	Tape   replay.Transcript
	Replay replay.Config
	Agent  agent.Config
	Binary string
}

func New(t *testing.T, binary string, tape replay.Transcript, data, sid, workspace string, gates ...string) *Fixture {
	t.Helper()
	dir := Canonical(t, t.TempDir())
	raw, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	binary = filepath.Join(dir, "pi-replay.exe")
	if err := os.WriteFile(binary, raw, 0700); err != nil {
		t.Fatal(err)
	}
	data = Canonical(t, data)
	work := Canonical(t, workspace)
	if tape.Header.Scenario == "symlinked_workspace" {
		alias := filepath.Join(t.TempDir(), "workspace-link")
		if err := os.Symlink(work, alias); err != nil {
			t.Skipf("无法创建工作目录符号链接: %v", err)
		}
		workspace = alias
	} else {
		workspace = work
	}
	bindings := map[string]string{"<fixture>": dir, "<home>": dir, "<node_data>": data, "<node_data_alias>": data, "<workspace>": work}
	// 仅向回放器传入头部声明的名字，系统提示中的 <tools> 等文本保持原样。
	declared := map[string]string{}
	for _, name := range tape.Header.Bindings {
		value, ok := bindings[name]
		if !ok {
			t.Fatalf("未提供绑定 %s", name)
		}
		declared[name] = value
	}
	tapePath := filepath.Join(dir, "transcript.ndjson")
	f, err := os.Create(tapePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := replay.Write(f, tape); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	c := replay.Config{Transcript: tapePath, StateDir: filepath.Join(dir, "state"), Bindings: declared, Gates: gates}
	raw, err = json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary+".replay.json", raw, 0600); err != nil {
		t.Fatal(err)
	}
	model := Model
	if tape.Header.Scenario == "provider_error" {
		model = "google-vertex/baton-nonexistent-model-ps174"
	}
	sessionDir := ""
	for _, e := range tape.Entries {
		if e.Type == "process_start" && e.Process == 2 {
			for i, arg := range e.Args {
				if arg == "--session-dir" {
					raw, _ := json.Marshal(e.Args[i+1])
					expanded, err := replay.Expand(raw, declared, map[string]any{"<$session_id_1>": sid})
					if err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(expanded, &sessionDir); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
	}
	fixture := &Fixture{Tape: tape, Replay: c, Binary: binary, Agent: agent.Config{Binary: binary, Directory: workspace, SessionDir: filepath.FromSlash(sessionDir), SessionID: sid, Model: model, Home: dir}}
	t.Cleanup(func() { fixture.Check(t) })
	return fixture
}

func (f *Fixture) Check(t *testing.T) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.Replay.StateDir, "failure.json"))
	if err == nil {
		t.Errorf("转录失配: %s", raw)
	} else if !os.IsNotExist(err) {
		t.Error(err)
	}
}

func (f *Fixture) Wait(t *testing.T, label string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := replay.WaitReached(ctx, f.Replay.StateDir, label); err != nil {
		f.Check(t)
		t.Fatalf("等待 %s: %v", label, err)
	}
}

func (f *Fixture) Release(t *testing.T, label string) {
	t.Helper()
	if err := replay.Release(f.Replay.StateDir, label); err != nil {
		t.Fatal(err)
	}
}

func (f *Fixture) Captures(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.Replay.StateDir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Captures map[string]any `json:"captures"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	return state.Captures
}

func (f *Fixture) Delivery(t *testing.T) string {
	t.Helper()
	for _, e := range f.Tape.Entries {
		if e.Label == "request:prompt:2" {
			var frame struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(e.Frame, &frame); err != nil {
				t.Fatal(err)
			}
			captures := f.Captures(t)
			captures["<$delivery_id_1>"] = "33333333-3333-4333-8333-333333333333"
			raw, err := replay.Expand(json.RawMessage(frame.Message), f.Replay.Bindings, captures)
			if err != nil {
				t.Fatal(err)
			}
			return string(raw)
		}
	}
	t.Fatal("转录没有交付输入")
	return ""
}

func (f *Fixture) VersionProbe(t *testing.T) {
	t.Helper()
	cmd := exec.Command(f.Binary, "--version")
	cmd.Dir = f.Agent.Directory
	if raw, err := cmd.CombinedOutput(); err != nil || strings.TrimSpace(string(raw)) != "1.3.0" {
		f.Check(t)
		t.Fatalf("录制中的子任务版本探测: %s %v", raw, err)
	}
}

func LastExit(tape replay.Transcript, process int) string {
	for _, e := range tape.Entries {
		if e.Process == process && e.Type == "runtime_exit" {
			return e.Label
		}
	}
	panic(fmt.Sprintf("进程 %d 没有退出条目", process))
}

// BeforeDeliveryHistory 给交付请求后的首条历史追加设门，不改变录制内容。
func BeforeDeliveryHistory(tape replay.Transcript) replay.Transcript {
	seen := false
	tape.Entries = append([]replay.Entry(nil), tape.Entries...)
	for i, e := range tape.Entries {
		if e.Label == "request:prompt:2" {
			seen = true
		}
		if seen && e.Type == "native_history" {
			tape.Entries[i].Label = "history:delivery"
			return tape
		}
	}
	panic("交付历史缺失")
}

var Variants = []string{"exit_mid_turn", "missing_settled", "abort_missing_settled", "quota_error"}

func Tape(t *testing.T, dir, name string) replay.Transcript {
	t.Helper()
	base := name
	switch name {
	case "exit_mid_turn", "missing_settled", "quota_error":
		base = "simple"
	case "abort_missing_settled":
		base = "interrupt_mid_tool"
	}
	tape := Read(t, filepath.Join(dir, base+".ndjson"))
	var err error
	switch name {
	case "exit_mid_turn":
		tape, err = tape.CutAfter("event:tool_execution_start")
	case "missing_settled", "abort_missing_settled":
		tape, err = tape.Drop("event:agent_settled")
	case "quota_error":
		// 配额耗尽无法在无模型 CI 中按需制造；只替换最终 assistant 的合法错误取值。
		label := ""
		for _, e := range tape.Entries {
			if e.Type == "emit_inbound" {
				var f struct {
					Type    string
					Message struct{ Role string }
				}
				_ = json.Unmarshal(e.Frame, &f)
				if f.Type == "message_end" && f.Message.Role == "assistant" {
					label = e.Label
				}
			}
		}
		tape, err = tape.Replace(label, json.RawMessage(`{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"quota exceeded"}}`))
	}
	if err != nil {
		t.Fatal(err)
	}
	return tape
}

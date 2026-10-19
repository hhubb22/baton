// Package codexreplaytest 为适配器和 Worker 提供早到中止的派生回放。
package codexreplaytest

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agent/replay"
)

func Build(t *testing.T, source string) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "codex-replay.exe")
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

// WithoutProbe 去掉真实入口在 CreateSession 前单独执行的版本探测。
func WithoutProbe(tape replay.Transcript) replay.Transcript {
	entries := make([]replay.Entry, 0, len(tape.Entries))
	for _, e := range tape.Entries {
		if e.Process == 1 {
			continue
		}
		e.Process--
		entries = append(entries, e)
	}
	tape.Entries = entries
	return tape
}

func RecordedEarlyInterrupt(t *testing.T, dir string) replay.Transcript {
	t.Helper()
	tape := WithoutProbe(Read(t, filepath.Join(dir, "interrupt_before_turn_started.ndjson")))
	// 录制器被 Close 杀掉，未录下退出帧；增加退出门供测试持有进程。
	tape.Entries = append(tape.Entries, replay.Entry{Type: "runtime_exit", Process: 2, Label: "process:done"})
	return tape
}

// EarlyInterrupt 保留真实 simple 的握手和输入，手写重排中止窗口。
// -32600、重复/其他回合通知和补发失败无法在真实调用中稳定安排。
func EarlyInterrupt(t *testing.T, dir, variant string) replay.Transcript {
	t.Helper()
	tape := WithoutProbe(Read(t, filepath.Join(dir, "simple.ndjson")))
	var started, completed replay.Entry
	for _, e := range tape.Entries {
		switch e.Label {
		case "event:turn/started":
			started = e
		case "event:turn/completed":
			completed = e
		}
	}
	var entries []replay.Entry
	for _, e := range tape.Entries {
		entries = append(entries, e)
		if e.Label == "response:turn/start" {
			break
		}
	}
	tape.Entries = entries
	add := func(kind, label, frame string) {
		tape.Entries = append(tape.Entries, replay.Entry{Type: kind, Process: 2, Label: label, Frame: json.RawMessage(frame)})
	}
	request := func(id string) string {
		return `{"jsonrpc":"2.0","id":"<$` + id + `>","method":"turn/interrupt","params":{"threadId":"thread-1","turnId":"turn-1"}}`
	}
	add("expect_outbound", "request:interrupt", request("interrupt"))
	started.Process = 2
	if variant == "started_before_error" {
		early := started
		early.Label = "event:early_started"
		tape.Entries = append(tape.Entries, early)
	}
	errorFrame := `{"id":"<$interrupt>","error":{"code":-32600,"message":"no active turn to interrupt"}}`
	if variant == "other_error" {
		errorFrame = `{"id":"<$interrupt>","error":{"code":-32600,"message":"thread not found"}}`
	}
	add("emit_inbound", "response:interrupt", errorFrame)
	// 其他 thread/turn 的开始和完成不能补发或确认停止。
	add("emit_inbound", "event:other_thread", `{"method":"turn/started","params":{"threadId":"thread-other","turn":{"id":"turn-1","status":"inProgress","items":[]}}}`)
	add("emit_inbound", "event:other_turn", `{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-other","status":"inProgress","items":[]}}}`)
	add("emit_inbound", "event:other_completed", `{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-other","status":"interrupted","items":[]}}}`)
	if variant == "completed_before_started" {
		completed.Process = 2
		tape.Entries = append(tape.Entries, completed)
	}
	tape.Entries = append(tape.Entries, started)
	if variant != "completed_before_started" && variant != "other_error" {
		add("expect_outbound", "request:retry", request("retry"))
		response := `{"id":"<$retry>","result":{}}`
		if variant == "retry_error" {
			response = `{"id":"<$retry>","error":{"code":-32600,"message":"no active turn to interrupt"}}`
		}
		add("emit_inbound", "response:retry", response)
	}
	started.Label = "event:duplicate_started"
	tape.Entries = append(tape.Entries, started)
	if variant != "completed_before_started" {
		// 沿用真实完成帧的合法 turn 结构，仅改成 interrupted。
		var f map[string]any
		if err := json.Unmarshal(completed.Frame, &f); err != nil {
			t.Fatal(err)
		}
		turn := f["params"].(map[string]any)["turn"].(map[string]any)
		turn["status"], turn["items"] = "interrupted", []any{}
		completed.Frame, _ = json.Marshal(f)
		completed.Process = 2
		tape.Entries = append(tape.Entries, completed)
	}
	add("expect_outbound", "request:history", `{"jsonrpc":"2.0","id":"<$history>","method":"thread/items/list","params":{"threadId":"thread-1","cursor":null,"limit":16,"sortDirection":"asc"}}`)
	add("emit_inbound", "response:history", `{"id":"<$history>","result":{"data":[]}}`)
	tape.Entries = append(tape.Entries, replay.Entry{Type: "runtime_exit", Process: 2, Label: "process:done"})
	return tape
}

type Fixture struct{ StateDir, Binary string }

func New(t *testing.T, binary, work, home string, tape replay.Transcript, gates ...string) *Fixture {
	t.Helper()
	dir := t.TempDir()
	raw, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	binary = filepath.Join(dir, "codex-replay.exe")
	if err := os.WriteFile(binary, raw, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "transcript.ndjson")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := replay.Write(f, tape); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	c := replay.Config{Transcript: path, StateDir: filepath.Join(dir, "state"), Bindings: map[string]string{"<workspace>": work, "<home>": home}, Gates: gates}
	raw, _ = json.Marshal(c)
	if err := os.WriteFile(binary+".replay.json", raw, 0600); err != nil {
		t.Fatal(err)
	}
	fixture := &Fixture{StateDir: c.StateDir, Binary: binary}
	t.Cleanup(func() { fixture.Check(t) })
	return fixture
}

func (f *Fixture) Check(t *testing.T) {
	t.Helper()
	if raw, err := os.ReadFile(filepath.Join(f.StateDir, "failure.json")); err == nil {
		t.Errorf("转录失配: %s", raw)
	} else if !os.IsNotExist(err) {
		t.Error(err)
	}
}

func (f *Fixture) Wait(t *testing.T, label string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := replay.WaitReached(ctx, f.StateDir, label); err != nil {
		f.Check(t)
		t.Fatalf("等待 %s: %v", label, err)
	}
}

func (f *Fixture) Release(t *testing.T, label string) {
	t.Helper()
	if err := replay.Release(f.StateDir, label); err != nil {
		t.Fatal(err)
	}
}

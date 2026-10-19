// Package replaytest 为 Codex 适配器与 Worker 测试准备真实录制转录。
package replaytest

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"baton/internal/agent/replay"
)

func Build(t *testing.T, source string) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "agent-replay.exe")
	if out, err := exec.Command("go", "build", "-o", binary, source).CombinedOutput(); err != nil {
		t.Fatalf("编译回放 Agent: %v\n%s", err, out)
	}
	return binary
}

func Load(t *testing.T, path string) replay.Transcript {
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

// CommandStartLabel 返回真实录制中运行态命令的开始事件，不用模型评论代替工具事实。
func CommandStartLabel(t *testing.T, tape replay.Transcript) string {
	t.Helper()
	for _, e := range tape.Entries {
		if e.Type != "emit_inbound" {
			continue
		}
		var f struct {
			Method string
			Params struct{ Item struct{ Type, Status string } }
		}
		if json.Unmarshal(e.Frame, &f) == nil && f.Method == "item/started" && f.Params.Item.Type == "commandExecution" && f.Params.Item.Status == "inProgress" {
			return e.Label
		}
	}
	t.Fatal("真实录制缺少运行态 commandExecution 开始事件")
	return ""
}

// AdapterTape 只保留与 app-server 成对的版本探测，去掉录制驱动及被筛除子会话的独立探测。
func AdapterTape(tape replay.Transcript) replay.Transcript {
	var starts []replay.Entry
	for _, e := range tape.Entries {
		if e.Type == "process_start" {
			starts = append(starts, e)
		}
	}
	mapping := map[int]int{}
	for i, e := range starts {
		if len(e.Args) == 1 && e.Args[0] == "--version" && (i+1 == len(starts) || len(starts[i+1].Args) == 0 || starts[i+1].Args[0] != "app-server") {
			continue
		}
		mapping[e.Process] = len(mapping) + 1
	}
	var entries []replay.Entry
	for _, e := range tape.Entries {
		if p, ok := mapping[e.Process]; ok {
			e.Process = p
			entries = append(entries, e)
		}
	}
	tape.Entries = entries
	return tape
}

// QueriedDelivery 读取录制中成功 result 工具输出的精确交付 ID。
func QueriedDelivery(t *testing.T, tape replay.Transcript) string {
	t.Helper()
	for _, e := range tape.Entries {
		if e.Type != "emit_inbound" {
			continue
		}
		var f struct {
			Params struct {
				Item struct {
					Type, AggregatedOutput string
					ExitCode               *int
				}
			}
		}
		if json.Unmarshal(e.Frame, &f) != nil || f.Params.Item.Type != "commandExecution" || f.Params.Item.ExitCode == nil || *f.Params.Item.ExitCode != 0 {
			continue
		}
		var result struct {
			DeliveryID string `json:"delivery_id"`
		}
		if json.Unmarshal([]byte(f.Params.Item.AggregatedOutput), &result) == nil && result.DeliveryID != "" {
			return result.DeliveryID
		}
	}
	t.Fatal("录制缺少成功 result 工具的 delivery_id")
	return ""
}

type Run struct {
	Binary, Work, Alias, Home, State string
	Tape                             replay.Transcript
	Config                           replay.Config
}

func Prepare(t *testing.T, binary string, tape replay.Transcript, gates ...string) *Run {
	t.Helper()
	dir := t.TempDir()
	raw, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	r := &Run{Binary: filepath.Join(dir, "codex-replay.exe"), Home: dir, State: filepath.Join(dir, "replay-state"), Tape: tape}
	r.Work, err = filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r.Alias = r.Work
	if tape.Header.Scenario == "symlinked_workspace" {
		r.Alias = filepath.Join(t.TempDir(), "workspace")
		if err := os.Symlink(r.Work, r.Alias); err != nil {
			t.Skipf("无法创建目录符号链接: %v", err)
		}
	}
	if err := os.WriteFile(r.Binary, raw, 0700); err != nil {
		t.Fatal(err)
	}
	r.Config = replay.Config{Transcript: filepath.Join(dir, "tape.ndjson"), StateDir: r.State, Bindings: map[string]string{"<home>": r.Home, "<workspace>": r.Work, "<workspace_alias>": r.Alias}, Gates: gates}
	for _, binding := range tape.Header.Bindings {
		if _, ok := r.Config.Bindings[binding]; !ok {
			r.Config.Bindings[binding] = t.TempDir()
		}
	}
	r.Save(t)
	t.Cleanup(func() { r.Check(t) })
	return r
}

func (r *Run) Save(t *testing.T) {
	t.Helper()
	f, err := os.Create(r.Config.Transcript)
	if err != nil {
		t.Fatal(err)
	}
	err = replay.Write(f, r.Tape)
	closeErr := f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	raw, err := json.Marshal(r.Config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.Binary+".replay.json", raw, 0600); err != nil {
		t.Fatal(err)
	}
}
func (r *Run) Check(t *testing.T) {
	t.Helper()
	if raw, err := os.ReadFile(filepath.Join(r.State, "failure.json")); err == nil {
		t.Errorf("转录失配: %s", raw)
	} else if !os.IsNotExist(err) {
		t.Error(err)
	}
}
func (r *Run) Wait(t *testing.T, label string) {
	t.Helper()
	// 长转录逐帧持久化状态，Windows 原生 CI 需要容纳文件权限检查与同步写入。
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := replay.WaitReached(ctx, r.State, label); err != nil {
		r.Check(t)
		t.Fatalf("等待 %s: %v", label, err)
	}
}
func (r *Run) Release(t *testing.T, label string) {
	t.Helper()
	if err := replay.Release(r.State, label); err != nil {
		t.Fatal(err)
	}
}

// EndGates 在每个 app-server 的最后一个条目后设门，证明预期请求均已消费。
func EndGates(tape replay.Transcript) (replay.Transcript, []string) {
	var out []replay.Entry
	var gates []string
	servers := map[int]bool{}
	for _, e := range tape.Entries {
		if e.Type == "process_start" && len(e.Args) > 0 && e.Args[0] == "app-server" {
			servers[e.Process] = true
		}
	}
	for i, e := range tape.Entries {
		if servers[e.Process] && e.Type == "runtime_exit" && e.Code == 0 && e.Signal == "" {
			if e.Label == "" {
				e.Label = "test:end:" + strconv.Itoa(e.Process)
			}
			gates = append(gates, e.Label)
		}
		out = append(out, e)
		if (i == len(tape.Entries)-1 || tape.Entries[i+1].Process != e.Process) && e.Type != "runtime_exit" {
			label := "test:end:" + strconv.Itoa(e.Process)
			out = append(out, replay.Entry{Type: "emit_stderr", Process: e.Process, Label: label})
			gates = append(gates, label)
		}
	}
	tape.Entries = out
	return tape, gates
}
func Frame(t *testing.T, tape replay.Transcript, label string) map[string]any {
	t.Helper()
	for _, e := range tape.Entries {
		if e.Label == label {
			var f map[string]any
			if err := json.Unmarshal(e.Frame, &f); err != nil {
				t.Fatal(err)
			}
			return f
		}
	}
	t.Fatalf("缺少 %s", label)
	return nil
}
func Replace(t *testing.T, tape replay.Transcript, label string, frame any) replay.Transcript {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	out, err := tape.Replace(label, raw)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// SelectReads 保留调用方实际执行的只读查询，不改变所选请求与响应的内容。
func SelectReads(tape replay.Transcript, keep map[string]bool) replay.Transcript {
	ids := map[string]bool{}
	for _, e := range tape.Entries {
		if e.Type == "expect_outbound" {
			var f struct {
				ID     string
				Method string
			}
			_ = json.Unmarshal(e.Frame, &f)
			if (f.Method == "thread/items/list") && !keep[e.Label] {
				ids[f.ID] = true
			}
		}
	}
	var out []replay.Entry
	for _, e := range tape.Entries {
		var f struct{ ID string }
		_ = json.Unmarshal(e.Frame, &f)
		if ids[f.ID] {
			continue
		}
		out = append(out, e)
	}
	tape.Entries = out
	return tape
}

// CrashGate 在 CutAfter 的强制退出前设门，允许测试确认此前的响应已经被消费。
func CrashGate(tape replay.Transcript) (replay.Transcript, string) {
	for i, e := range tape.Entries {
		if e.Type == "runtime_exit" && e.Signal == "SIGKILL" {
			label := "test:crash:" + strconv.Itoa(e.Process)
			tape.Entries[i].Label = label
			return tape, label
		}
	}
	return tape, ""
}

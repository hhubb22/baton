// Package kiroreplaytest 为适配器与 Worker 提供同一份 Kiro 真实转录。
package kiroreplaytest

import (
	"baton/internal/agent/replay"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
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

func Cases(t *testing.T, dir string) []replay.Transcript {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(dir, "*.ndjson"))
	if err != nil || len(paths) == 0 {
		t.Fatal("缺少真实转录", err)
	}
	var tapes []replay.Transcript
	for _, p := range paths {
		tapes = append(tapes, Load(t, p))
	}
	simple := Load(t, filepath.Join(dir, "simple.ndjson"))
	// 真实环境无法按需制造丢响应；保留录制的输入和事件，只截断进程。
	for _, name := range []string{"crash_after_prompt", "missing_prompt_response"} {
		label := "request:session/prompt"
		if name == "missing_prompt_response" {
			for i, e := range simple.Entries {
				if e.Label == "response:session/prompt" {
					label = simple.Entries[i-1].Label
					break
				}
			}
		}
		derived, err := simple.CutAfter(label)
		if err != nil {
			t.Fatal(err)
		}
		derived.Header.Scenario = name
		tapes = append(tapes, derived)
	}
	return tapes
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
	r := &Run{Binary: filepath.Join(dir, "kiro-replay.exe"), Home: dir, State: filepath.Join(dir, "replay-state"), Tape: tape}
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

// EndGates 在每个 ACP 的最后一个条目后设门，证明预期请求均已消费。
func EndGates(tape replay.Transcript) (replay.Transcript, []string) {
	var out []replay.Entry
	var gates []string
	servers := map[int]bool{}
	for _, e := range tape.Entries {
		if e.Type == "expect_outbound" {
			var f struct{ Method string }
			_ = json.Unmarshal(e.Frame, &f)
			if f.Method == "session/new" || f.Method == "session/prompt" {
				servers[e.Process] = true
			}
		}
	}
	last := map[int]int{}
	for i, e := range tape.Entries {
		last[e.Process] = i
	}
	for i, e := range tape.Entries {
		if servers[e.Process] && e.Type == "runtime_exit" && e.Code == 0 && e.Signal == "" {
			if e.Label == "" {
				e.Label = "test:end:" + strconv.Itoa(e.Process)
			}
			gates = append(gates, e.Label)
		}
		out = append(out, e)
		if servers[e.Process] && (last[e.Process] == i) && e.Type != "runtime_exit" {
			label := "test:end:" + strconv.Itoa(e.Process)
			out = append(out, replay.Entry{Type: "emit_stderr", Process: e.Process, Label: label})
			gates = append(gates, label)
		}
	}
	tape.Entries = out
	return tape, gates
}

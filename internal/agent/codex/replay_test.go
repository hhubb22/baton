package codex

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

func TestTranscriptReplaySimple(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex-replay.exe")
	build := exec.Command("go", "build", "-o", binary, "../../../tools/agent-replay")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("编译回放 Agent: %v\n%s", err, output)
	}
	tape, err := filepath.Abs("testdata/replay/simple.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	// macOS 的临时目录可能经过符号链接，绑定适配器实际使用的目录。
	work, err = filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	c := replay.Config{Transcript: tape, StateDir: filepath.Join(dir, "replay-state"), Bindings: map[string]string{"<workspace>": work, "<home>": dir}, Gates: []string{"event:turn/completed", "process:done"}}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary+".replay.json", raw, 0600); err != nil {
		t.Fatal(err)
	}
	a := New(Config{Directory: work, SessionDir: dir, SessionID: "session-runtime", ExecutionID: "execution-runtime", StatePath: filepath.Join(dir, "native-state.json"), Home: dir, Model: "fixture-model", Binary: binary})
	defer a.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	checkFailure := func() {
		t.Helper()
		if raw, err := os.ReadFile(filepath.Join(c.StateDir, "failure.json")); err == nil {
			t.Fatalf("转录失配: %s", raw)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	if err := a.Start(ctx); err != nil {
		checkFailure()
		t.Fatal(err)
	}
	if snapshot := a.Snapshot(); snapshot.ThreadID != "thread-1" || snapshot.SessionID != "session-runtime" {
		t.Fatalf("会话绑定: %+v", snapshot)
	}
	if out, err := a.SubmitInput(ctx, `{"description":"fixture task","generation":1}`); err != nil || out.Final != "" {
		checkFailure()
		t.Fatalf("输入: %+v %v", out, err)
	}
	if err := replay.WaitReached(ctx, c.StateDir, "event:turn/completed"); err != nil {
		checkFailure()
		t.Fatal(err)
	}
	for _, out := range a.Drain() {
		if out.Final != "" || out.Exited {
			t.Fatalf("完成通知前报告了结果: %+v", out)
		}
	}
	if err := replay.Release(c.StateDir, "event:turn/completed"); err != nil {
		t.Fatal(err)
	}
	if err := replay.WaitReached(ctx, c.StateDir, "process:done"); err != nil {
		checkFailure()
		t.Fatal(err)
	}
	var final string
	for final == "" {
		for _, out := range a.Drain() {
			if out.Uncertain {
				t.Fatalf("完成结果不确定: %+v", out)
			}
			if out.Final != "" {
				if !out.Exited {
					t.Fatal("未结算的结果")
				}
				final = out.Final
			}
		}
		if final != "" {
			break
		}
		select {
		case <-ctx.Done():
			checkFailure()
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	var result struct {
		Status, Summary     string
		Evidence, Artifacts []any
		Error               any
	}
	if err := json.Unmarshal([]byte(final), &result); err != nil || result.Status != "completed" || result.Summary != "fixture" || result.Error != nil || result.Evidence == nil || result.Artifacts == nil {
		t.Fatalf("结构化结果: %s %v", final, err)
	}
	stateRaw, err := os.ReadFile(filepath.Join(c.StateDir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Process  int
		Captures map[string]any
	}
	if err := json.Unmarshal(stateRaw, &state); err != nil || state.Process != 2 || state.Captures["<$operation_id>"] != "execution-runtime:1" {
		t.Fatalf("进程/输入次数: %s %v", stateRaw, err)
	}
	checkFailure()
}

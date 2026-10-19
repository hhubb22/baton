package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent/replay"
)

func TestTranscriptReplaySimple(t *testing.T) {
	tape, err := filepath.Abs("testdata/replay/simple.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	runTranscriptReplaySimple(t, tape, "process:done", "<$operation_id>", "execution-runtime:1")
}

func runTranscriptReplaySimple(t *testing.T, tape, doneLabel, captureKey string, captureValue any) {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "codex-replay.exe")
	build := exec.Command("go", "build", "-o", binary, "../../../tools/agent-replay")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("编译回放 Agent: %v\n%s", err, output)
	}
	work := t.TempDir()
	// macOS 的临时目录可能经过符号链接，绑定适配器实际使用的目录。
	work, err := filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	c := replay.Config{Transcript: tape, StateDir: filepath.Join(dir, "replay-state"), Bindings: map[string]string{"<workspace>": work, "<home>": dir}, Gates: []string{"event:turn/completed", doneLabel}}
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
	if err := replay.WaitReached(ctx, c.StateDir, doneLabel); err != nil {
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
	if err := json.Unmarshal(stateRaw, &state); err != nil || state.Process != 2 || state.Captures[captureKey] != captureValue {
		t.Fatalf("进程/输入次数: %s %v", stateRaw, err)
	}
	checkFailure()
}

// 合成原始录制覆盖 normalize -> NDJSON -> serve -> 真实 Adapter，期间不调用模型。
func TestNormalizeTranscriptReplaySimple(t *testing.T) {
	f, err := os.Open("testdata/replay/simple.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := replay.Read(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	header := fixture.Header
	header.Normalization = ""
	header.Source = "synthetic raw recording"
	bindings := map[string]string{"<workspace>": "/synthetic/workspace", "<home>": "/synthetic/home"}
	raw := replay.RawRecording{Header: replay.RawHeader{Type: "raw_start", Version: 1, Transcript: header, Bindings: bindings, Hostname: "synthetic-host", Username: "synthetic-user"}}
	captures := map[string]any{"<$initialize_id>": json.Number("41"), "<$thread_start_id>": json.Number("42"), "<$turn_start_id>": json.Number("43"), "<$operation_id>": "record-execution:1"}
	for i, e := range fixture.Entries {
		r := replay.RawEntry{Type: e.Type, Process: e.Process, ElapsedNS: int64(i), Args: e.Args, Code: e.Code, Signal: e.Signal}
		switch e.Type {
		case "expect_outbound", "emit_inbound":
			frame, err := replay.Expand(e.Frame, bindings, captures)
			if err != nil {
				t.Fatal(err)
			}
			// 原始录制中的 Baton 文本具有实际值，规范化必须自行识别这些位置。
			frame = bytes.ReplaceAll(frame, []byte("<any>"), []byte("synthetic Baton text"))
			var plain map[string]string
			if json.Unmarshal(frame, &plain) == nil && len(plain) == 1 && plain["text"] != "" {
				r.Data = []byte(plain["text"] + "\n")
			} else {
				r.Data = append(frame, '\n')
			}
			r.Type = map[string]string{"expect_outbound": "stdin", "emit_inbound": "stdout"}[e.Type]
		}
		raw.Entries = append(raw.Entries, r)
	}
	dir := t.TempDir()
	input, output := filepath.Join(dir, "raw.ndjson"), filepath.Join(dir, "simple.ndjson")
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	if err := enc.Encode(raw.Header); err != nil {
		t.Fatal(err)
	}
	for _, e := range raw.Entries {
		if err := enc.Encode(e); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(input, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replay.NormalizeFile(input, output); err != nil {
		t.Fatal(err)
	}
	normalized, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(normalized), "synthetic Baton text") {
		t.Fatal("Baton 文本未变成通配符")
	}
	tape, err := replay.Read(bytes.NewReader(normalized))
	if err != nil {
		t.Fatal(err)
	}
	if tape.Header.Normalization != "v1" || tape.Header.DroppedFrames != 0 {
		t.Fatal(fmt.Sprint(tape.Header))
	}
	runTranscriptReplaySimple(t, output, "process:done:2", "<$execution_id_1>", "execution-runtime")
}

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent/replay"
)

func frame(s string) json.RawMessage { return json.RawMessage(s) }

func TestServeProcess(t *testing.T) {
	compiled := filepath.Join(t.TempDir(), "agent-replay.exe")
	build := exec.Command("go", "build", "-o", compiled, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("编译回放工具: %v\n%s", err, output)
	}
	binary, err := os.ReadFile(compiled)
	if err != nil {
		t.Fatal(err)
	}
	prepare := func(t *testing.T, entries []replay.Entry, gates []string) (string, replay.Config) {
		t.Helper()
		dir := t.TempDir()
		path := filepath.Join(dir, "fixture.exe")
		if err := os.WriteFile(path, binary, 0755); err != nil {
			t.Fatal(err)
		}
		tape := replay.Transcript{Header: replay.Header{Type: "transcript_start", Protocol: "jsonrpc", Platform: "darwin/arm64", Source: "handwritten-test"}, Entries: entries}
		var buf bytes.Buffer
		if err := replay.Write(&buf, tape); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "transcript.ndjson"), buf.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		c := replay.Config{Transcript: "transcript.ndjson", StateDir: "state", Bindings: map[string]string{"<workspace>": filepath.Join(dir, "work"), "<windows_path>": `C:\temp\work "quoted"`}, Gates: gates}
		raw, err := json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path+".replay.json", raw, 0600); err != nil {
			t.Fatal(err)
		}
		loaded, err := replay.LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		return path, loaded
	}
	run := func(t *testing.T, path, input string, args ...string) ([]byte, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path, args...)
		cmd.Dir = t.TempDir()
		cmd.Stdin = strings.NewReader(input)
		return cmd.CombinedOutput()
	}
	base := []replay.Entry{{Type: "process_start", Process: 1, Args: []string{"rpc"}}, {Type: "expect_outbound", Process: 1, Label: "request:go", Frame: frame(`{"id":"<$request>","method":"go","params":{"value":1}}`)}, {Type: "emit_inbound", Process: 1, Label: "response:go", Frame: frame(`{"id":"<$request>","result":{"ok":true}}`)}, {Type: "runtime_exit", Process: 1}}
	request := "{\"id\":42,\"method\":\"go\",\"params\":{\"value\":1}}\n"
	for _, tc := range []struct {
		name, input string
		args        []string
		fail        bool
	}{
		{"success", request, []string{"serve", "rpc"}, false},
		{"extra", request + "{}\n", []string{"rpc"}, true},
		{"missing", "", []string{"rpc"}, true},
		{"field", strings.Replace(request, `"value":1`, `"value":2`, 1), []string{"rpc"}, true},
		{"args", request, []string{"wrong"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, c := prepare(t, base, nil)
			output, err := run(t, path, tc.input, tc.args...)
			if (err != nil) != tc.fail {
				t.Fatalf("退出: %v %s", err, output)
			}
			raw, readErr := os.ReadFile(filepath.Join(c.StateDir, "failure.json"))
			if !tc.fail {
				if !os.IsNotExist(readErr) || !strings.Contains(string(output), `"id":42`) {
					t.Fatalf("成功结果: %s, failure=%s %v", output, raw, readErr)
				}
				return
			}
			var failure replay.Failure
			if readErr != nil || json.Unmarshal(raw, &failure) != nil || failure.Entry < 2 || failure.Reason == "" || failure.Process != 1 {
				t.Fatalf("失配诊断: %s %v", raw, readErr)
			}
			if tc.name == "field" && (failure.Label != "request:go" || !json.Valid(failure.Expected) || !json.Valid(failure.Actual)) {
				t.Fatal(string(raw))
			}
		})
	}
	t.Run("captures_across_processes", func(t *testing.T) {
		entries := []replay.Entry{
			{Type: "process_start", Process: 1, Args: []string{"--session-id", "<$session_id>"}},
			{Type: "expect_outbound", Process: 1, Frame: frame(`{"id":"<$request_id>","method":"go","params":{"cwd":"<workspace>","foreignPath":"<windows_path>","session":"<$session_id>"}}`)},
			{Type: "runtime_exit", Process: 1},
			{Type: "process_start", Process: 2, Args: []string{"resume", "<$session_id>"}},
			{Type: "emit_inbound", Process: 2, Frame: frame(`{"id":"approval-1","method":"approve","params":{}}`)},
			{Type: "expect_outbound", Process: 2, Frame: frame(`{"id":"approval-1","result":{}}`)},
			{Type: "emit_inbound", Process: 2, Frame: frame(`{"id":"<$request_id>","result":{"session":"<$session_id>","cwd":"<workspace>"}}`)},
			{Type: "runtime_exit", Process: 2},
		}
		path, c := prepare(t, entries, nil)
		request, _ := json.Marshal(map[string]any{"id": json.Number("9007199254740993"), "method": "go", "params": map[string]string{"cwd": c.Bindings["<workspace>"], "foreignPath": c.Bindings["<windows_path>"], "session": "generated-id"}})
		if output, err := run(t, path, string(request)+"\n", "--session-id", "generated-id"); err != nil {
			t.Fatalf("进程 1: %v %s", err, output)
		}
		output, err := run(t, path, "{\"id\":\"approval-1\",\"result\":{}}\n", "resume", "generated-id")
		if err != nil {
			t.Fatalf("进程 2: %v %s", err, output)
		}
		var response struct {
			ID     json.Number
			Result struct{ Session, Cwd string }
		}
		decoder := json.NewDecoder(bytes.NewReader(output))
		var approval map[string]any
		if err := decoder.Decode(&approval); err != nil || approval["id"] != "approval-1" {
			t.Fatalf("Agent 请求 id: %s %v", output, err)
		}
		if err := decoder.Decode(&response); err != nil || response.ID != "9007199254740993" || response.Result.Session != "generated-id" || response.Result.Cwd != c.Bindings["<workspace>"] {
			t.Fatalf("捕获/路径: %s %v", output, err)
		}
		if _, err := run(t, path, "", "resume", "generated-id"); err == nil {
			t.Fatal("额外进程未失败")
		}
	})
	t.Run("gate_history_and_stderr", func(t *testing.T) {
		entries := []replay.Entry{
			{Type: "process_start", Process: 1},
			{Type: "native_history", Process: 1, Path: "<workspace>/history.jsonl", Append: `{"cwd":"<workspace>"}` + "\n"},
			{Type: "emit_stderr", Process: 1, Text: "history ready"},
			{Type: "emit_inbound", Process: 1, Label: "event:turn/started", Frame: frame(`{"event":"started"}`)},
			{Type: "runtime_exit", Process: 1},
		}
		path, c := prepare(t, entries, []string{"event:turn/started"})
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		lines := make(chan string, 1)
		go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); lines <- line }()
		if err := replay.WaitReached(ctx, c.StateDir, "event:turn/started"); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(c.Bindings["<workspace>"], "history.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		var history map[string]string
		if err := json.Unmarshal(data, &history); err != nil || history["cwd"] != c.Bindings["<workspace>"] {
			t.Fatalf("历史未落盘: %s %v", data, err)
		}
		select {
		case line := <-lines:
			t.Fatalf("release 前输出: %q", line)
		case <-time.After(30 * time.Millisecond):
		}
		if err := replay.Release(c.StateDir, "event:turn/started"); err != nil {
			t.Fatal(err)
		}
		select {
		case line := <-lines:
			if line != "{\"event\":\"started\"}\n" {
				t.Fatal(line)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		if err := cmd.Wait(); err != nil || stderr.String() != "history ready\n" {
			t.Fatalf("进程: %v %s", err, stderr.String())
		}
	})
	t.Run("cut_kills_process", func(t *testing.T) {
		tape := replay.Transcript{Header: replay.Header{Type: "transcript_start", Protocol: "jsonrpc"}, Entries: base}
		cut, err := tape.CutAfter("response:go")
		if err != nil {
			t.Fatal(err)
		}
		path, c := prepare(t, cut.Entries, nil)
		output, err := run(t, path, request, "rpc")
		if err == nil || !strings.Contains(string(output), `"ok":true`) {
			t.Fatalf("崩溃变体: %v %s", err, output)
		}
		if raw, err := os.ReadFile(filepath.Join(c.StateDir, "failure.json")); !os.IsNotExist(err) {
			t.Fatalf("预期崩溃被当成失配: %s %v", raw, err)
		}
	})
	t.Run("recorded_exit_code", func(t *testing.T) {
		path, c := prepare(t, []replay.Entry{{Type: "process_start", Process: 1}, {Type: "runtime_exit", Process: 1, Code: 7, Signal: "SIGTERM"}}, nil)
		_, err := run(t, path, "")
		if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 7 {
			t.Fatalf("退出码: %v", err)
		}
		if _, err := os.Stat(filepath.Join(c.StateDir, "failure.json")); !os.IsNotExist(err) {
			t.Fatal("预期退出产生 failure.json")
		}
	})
}

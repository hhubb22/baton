package pi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/agent"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("BATON_PI_DIAGNOSTIC_CHILD"); mode != "" {
		diagnosticChild(mode)
		os.Exit(0)
	}
	if os.Getenv("BATON_PI_REPLAY_CHILD") == "1" {
		replayChild()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func replayChild() {
	if expected := os.Getenv("BATON_PI_EXPECT_DIRECTORY"); expected != "" {
		cwd, err := os.Getwd()
		if err != nil || cwd != expected {
			fmt.Fprintln(os.Stderr, "Pi fixture cwd is outside the authorized directory")
			os.Exit(23)
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(Version)
		return
	}
	var id, dir, file string
	for i, v := range os.Args {
		if i+1 == len(os.Args) {
			continue
		}
		switch v {
		case "--session-id":
			id = os.Args[i+1]
		case "--session-dir":
			dir = os.Args[i+1]
		case "--session":
			file = os.Args[i+1]
		}
	}
	if file == "" {
		file = filepath.Join(dir, id+".jsonl")
	} else {
		raw, _ := os.ReadFile(file)
		var header mapping
		_ = json.Unmarshal(bytes.SplitN(raw, []byte{'\n'}, 2)[0], &header)
		id = header.ID
	}
	var mu sync.Mutex
	write := func(v any) { mu.Lock(); defer mu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
	appendMessage := func(role, text string) {
		if _, err := os.Stat(file); os.IsNotExist(err) {
			cwd, _ := os.Getwd()
			raw, _ := json.Marshal(map[string]any{"type": "session", "id": id, "version": 3, "cwd": cwd})
			_ = os.WriteFile(file, append(raw, '\n'), 0o600)
		}
		f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
		if f != nil {
			_ = json.NewEncoder(f).Encode(map[string]any{"type": "message", "message": map[string]any{"role": role, "content": text}})
			f.Close()
		}
	}
	_ = readFrames(os.Stdin, func(raw []byte) error {
		var cmd map[string]any
		_ = json.Unmarshal(raw, &cmd)
		typ, _ := cmd["type"].(string)
		r := map[string]any{"type": "response", "id": cmd["id"], "command": typ, "success": true}
		switch typ {
		case "set_auto_retry":
			r["success"] = cmd["enabled"] == false
		case "get_state":
			if expected := os.Getenv("BATON_PI_EXPECT_CONTEXT"); expected != "" && os.Getenv("BATON_CONTEXT_FILE") != expected {
				r["success"] = false
			}
			r["data"] = map[string]any{"sessionId": id, "sessionFile": file}
		case "prompt":
			payload, _ := cmd["message"].(string)
			appendMessage("user", payload)
			r["data"] = map[string]any{"disposition": "started"}
			write(r)
			if strings.Contains(payload, "hold") {
				write(map[string]any{"type": "agent_end", "willRetry": false})
				return nil
			}
			if strings.Contains(payload, "exit") {
				os.Exit(0)
			}
			fixture, _ := os.ReadFile(os.Getenv("BATON_PI_REPLAY_FIXTURE"))
			return readFrames(bytes.NewReader(fixture), func(raw []byte) error {
				var event map[string]any
				_ = json.Unmarshal(raw, &event)
				if msg, ok := event["message"].(map[string]any); ok {
					out, _ := json.Marshal(msg["content"])
					appendMessage("assistant", textContent(out))
				}
				write(event)
				return nil
			})
		case "abort":
			if os.Getenv("BATON_PI_REPLAY_ABORT_UNSETTLED") != "1" {
				write(map[string]any{"type": "agent_settled", "aborted": true})
			}
		case "clear_queue":
			r["data"] = map[string]any{"steering": []string{}, "followUp": []string{}}
		}
		if log := os.Getenv("BATON_PI_REPLAY_COMMANDS"); log != "" {
			f, _ := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
			if f != nil {
				fmt.Fprintln(f, typ)
				f.Close()
			}
		}
		write(r)
		return nil
	})
}

func TestPiProcessesUseConfiguredDirectory(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	config := agent.Config{Binary: exe, Directory: dir, SessionDir: filepath.Join(dir, "native"), SessionID: "cwd-fixture",
		Env: append(os.Environ(), "BATON_PI_REPLAY_CHILD=1", "BATON_PI_EXPECT_DIRECTORY="+dir)}
	for _, restore := range []bool{false, true} {
		config.Restore = restore
		a := New(config)
		t.Cleanup(func() { _ = a.Close() })
		if err := a.Start(context.Background()); err != nil {
			t.Fatalf("restore=%t: %v", restore, err)
		}
		if !restore {
			header, _ := json.Marshal(map[string]any{"type": "session", "id": config.SessionID, "version": 3, "cwd": dir})
			if err := os.WriteFile(a.history.File, append(header, '\n'), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func replayAdapter(t *testing.T) *Adapter {
	t.Helper()
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sample := os.Getenv("BATON_PI_REPLAY_SAMPLE")
	if sample == "" {
		sample = "1.3.0-lifecycle.jsonl"
	}
	fixture, err := filepath.Abs(filepath.Join("testdata", sample))
	if err != nil {
		t.Fatal(err)
	}
	a := New(agent.Config{Directory: dir, SessionDir: filepath.Join(dir, "native"), SessionID: "11111111-1111-4111-8111-111111111111", Binary: exe, ContextFile: filepath.Join(dir, "context.json"),
		Env: append(os.Environ(), "BATON_PI_REPLAY_CHILD=1", "BATON_PI_REPLAY_FIXTURE="+fixture, "BATON_PI_EXPECT_CONTEXT="+filepath.Join(dir, "context.json"), "BATON_PI_REPLAY_COMMANDS="+filepath.Join(dir, "commands"))})
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func TestPiAbortResponseAloneIsNotStoppingEvidence(t *testing.T) {
	t.Setenv("BATON_PI_REPLAY_ABORT_UNSETTLED", "1")
	a := replayAdapter(t)
	if _, err := a.SubmitInput(context.Background(), "hold"); err != nil {
		t.Fatal(err)
	}
	if stopped, known, err := a.Abort(); err == nil || stopped || known {
		t.Fatalf("control reply became stop evidence: %v %v %v", stopped, known, err)
	}
}

func TestPiWaitingAndErrorSettlement(t *testing.T) {
	for _, sample := range []string{"1.3.0-waiting.jsonl", "1.3.0-error.jsonl"} {
		t.Run(sample, func(t *testing.T) {
			t.Setenv("BATON_PI_REPLAY_SAMPLE", sample)
			a := replayAdapter(t)
			if _, err := a.SubmitInput(context.Background(), "task"); err != nil {
				t.Fatal(err)
			}
			out := waitOutput(t, a)
			if sample == "1.3.0-waiting.jsonl" {
				if !out.WaitingForChildren || out.Exited || out.Uncertain {
					t.Fatalf("waiting: %+v", out)
				}
			} else if !out.Uncertain || !out.Exited {
				t.Fatalf("error: %+v", out)
			}
		})
	}
}

func waitOutput(t *testing.T, a *Adapter) agent.Output {
	t.Helper()
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("Pi did not settle")
			return agent.Output{}
		case <-tick.C:
			if out := a.Drain(); len(out) > 0 {
				return out[len(out)-1]
			}
		}
	}
}

func TestPiReplaySettledAndNativeHistory(t *testing.T) {
	a := replayAdapter(t)
	if _, err := a.SubmitInput(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	out := waitOutput(t, a)
	if !out.Exited || !strings.Contains(out.Final, "\u2028") || out.Uncertain {
		t.Fatalf("invalid settlement: %+v", out)
	}
	if err := a.walkHistory(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := a.DeliverResult(context.Background(), "delivery-1", `{"delivery_id":"delivery-1"}`); err != nil {
		t.Fatal(err)
	}
	_ = waitOutput(t, a)
	if yes, err := a.HistoryContains("delivery-1", false); err != nil || !yes {
		t.Fatalf("native history: %v %v", yes, err)
	}
	if yes, err := a.HistoryContains("delivery-1", true); err != nil || yes {
		t.Fatalf("user input mistaken for tool result: %v %v", yes, err)
	}
	if _, err := a.DeliverResult(context.Background(), "delivery-1", `{"delivery_id":"delivery-1"}`); err != nil {
		t.Fatal(err)
	}
	if out := a.Drain(); len(out) > 0 {
		t.Fatal("duplicate delivery started a new turn")
	}
}

func TestPiReplayAgentEndIsNotSettledAndAbortClearsQueue(t *testing.T) {
	a := replayAdapter(t)
	if _, err := a.SubmitInput(context.Background(), "hold"); err != nil {
		t.Fatal(err)
	}
	if out := a.Drain(); len(out) > 0 {
		t.Fatal("agent_end completed task")
	}
	if _, err := a.SubmitInput(context.Background(), "second"); err == nil {
		t.Fatal("accepted concurrent input")
	}
	stopped, known, err := a.Abort()
	if err != nil || !stopped || !known {
		t.Fatalf("abort: %v %v %v", stopped, known, err)
	}
	raw, err := os.ReadFile(filepath.Join(a.config.Directory, "commands"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), "set_auto_retry\nget_state\n") || !strings.HasSuffix(string(raw), "clear_queue\nabort\n") {
		t.Fatalf("command order: %s", raw)
	}
}

func TestPiReplayExitIsUncertainAndRestoreNeverPrompts(t *testing.T) {
	a := replayAdapter(t)
	if _, err := a.SubmitInput(context.Background(), "exit"); err != nil {
		t.Fatal(err)
	}
	out := waitOutput(t, a)
	if !out.Uncertain || out.Exited {
		t.Fatalf("exit promoted to settled: %+v", out)
	}
	config := a.config
	config.Restore = true
	b := New(config)
	if err := b.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if len(b.Drain()) != 0 {
		t.Fatal("restore replayed task")
	}
	if err := os.Remove(a.history.File); err != nil {
		t.Fatal(err)
	}
	c := New(config)
	if err := c.Start(context.Background()); err != ErrHistoryMissing {
		t.Fatalf("missing history accepted: %v", err)
	}
}

type byteReader struct{ io.Reader }

func (r byteReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:1]) }

func TestPiLFFraming(t *testing.T) {
	input := []byte("{\"s\":\"汉字\u2028\u2029\"}\r\n{\"s\":\"" + strings.Repeat("a", 300000) + "\"}\n")
	count := 0
	if err := readFrames(byteReader{bytes.NewReader(input)}, func(raw []byte) error {
		count++
		if !json.Valid(raw) {
			t.Fatal("invalid split")
		}
		return nil
	}); err != nil || count != 2 {
		t.Fatalf("framing %d %v", count, err)
	}
	if err := readFrames(strings.NewReader(`{"unterminated":true}`), func([]byte) error { return nil }); err == nil {
		t.Fatal("accepted truncated frame")
	}
}

func TestPiNoModelProbe(t *testing.T) {
	if os.Getenv("BATON_PI_PROBE") != "1" {
		t.Skip("explicit BATON_PI_PROBE=1 required; no model task")
	}
	dir := t.TempDir()
	bin := os.Getenv("BATON_PI_BIN")
	if bin == "" {
		bin = "pi"
	}
	a := New(agent.Config{Binary: bin, Directory: dir, SessionDir: filepath.Join(dir, "native"), SessionID: "22222222-2222-4222-8222-222222222222",
		Env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "USERPROFILE=" + dir, "PI_CODING_AGENT_DIR=" + filepath.Join(dir, "config")}})
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := os.Stat(a.history.File); !os.IsNotExist(err) {
		t.Fatal("no-prompt handshake unexpectedly persisted conversation")
	}
	t.Logf("version=%s platform=%s/%s model=none initialization=支持 real_tasks=未验证", Version, runtime.GOOS, runtime.GOARCH)
}

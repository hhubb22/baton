package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/privatefile"
	"baton/internal/task"
	"github.com/santhosh-tekuri/jsonschema/v5"
	"github.com/sourcegraph/jsonrpc2"
)

// The subprocess uses exactly the same executable/stdio boundary as the CLI.
func TestMain(m *testing.M) {
	if os.Getenv("BATON_CODEX_FIXTURE") == "1" || (len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "app-server")) {
		os.Exit(replayServer())
	}
	os.Exit(m.Run())
}

func fixtureValue(key string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	dir, _ := os.Getwd()
	switch key {
	case "FIXTURE_TAPE":
		return filepath.Join(dir, "replay.json")
	case "FIXTURE_LOG":
		return filepath.Join(dir, "requests.jsonl")
	case "FIXTURE_CWD":
		return dir
	case "FIXTURE_MODE":
		raw, _ := os.ReadFile(filepath.Join(dir, "codex-fixture-mode"))
		return strings.TrimSpace(string(raw))
	}
	return ""
}

func replayServer() int {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		if fixtureValue("FIXTURE_MODE") == "wrongversion" {
			fmt.Println("codex-cli 0.0.0")
			return 0
		}
		fmt.Println("codex-cli " + Version)
		return 0
	}
	raw, err := os.ReadFile(fixtureValue("FIXTURE_TAPE"))
	if err != nil {
		return 1
	}
	var tape map[string]json.RawMessage
	if json.Unmarshal(raw, &tape) != nil {
		return 1
	}
	log, err := os.OpenFile(fixtureValue("FIXTURE_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 1
	}
	defer log.Close()
	enc := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), maxFrame)
	for scanner.Scan() {
		line := scanner.Bytes()
		_, _ = log.Write(append(append([]byte(nil), line...), '\n'))
		var req struct {
			ID     *json.RawMessage `json:"id"`
			Method string           `json:"method"`
			Params map[string]any   `json:"params"`
		}
		if json.Unmarshal(line, &req) != nil {
			return 2
		}
		if req.ID == nil {
			continue
		}
		mode := fixtureValue("FIXTURE_MODE")
		if req.Method == "turn/start" && mode == "disconnect" {
			return 0
		}
		if req.Method == "thread/resume" && mode == "incompatible" {
			_ = enc.Encode(map[string]any{"id": req.ID, "error": map[string]any{"code": -32601, "message": "experimental API unavailable"}})
			continue
		}
		result := tape[req.Method]
		switch req.Method {
		case "thread/resume":
			result = tape["thread/start"]
		case "thread/read":
			id := "thread-fixture"
			if mode == "missing" {
				id = "wrong-thread"
			}
			result, _ = json.Marshal(map[string]any{"thread": map[string]any{"id": id, "cwd": fixtureValue("FIXTURE_CWD")}})
		case "thread/turns/list":
			result = json.RawMessage(`{"data":[{"id":"turn-fixture","status":"completed","items":[]}]}`)
			if mode == "running" {
				result = json.RawMessage(`{"data":[{"id":"turn-fixture","status":"interrupted","items":[]}]}`)
			}
			if mode == "absentturn" {
				result = json.RawMessage(`{"data":[]}`)
			}
			if mode == "cycle" || (mode == "paged" && req.Params["cursor"] == nil) {
				result = json.RawMessage(`{"data":[],"nextCursor":"next"}`)
			}
		case "thread/items/list":
			var done struct {
				Turn turn `json:"turn"`
			}
			_ = json.Unmarshal(tape["turn/completed"], &done)
			result, _ = json.Marshal(map[string]any{"data": []any{map[string]any{"turnId": "turn-fixture", "item": done.Turn.Items[0]}}})
			if items, err := os.ReadFile(filepath.Join(fixtureValue("FIXTURE_CWD"), "history-items.json")); err == nil {
				result = items
			}
			if mode == "missing-items" {
				result = json.RawMessage(`{"data":[]}`)
			}
			if mode == "paged" && req.Params["cursor"] == nil {
				result = json.RawMessage(`{"data":[],"nextCursor":"next"}`)
			}
		case "turn/start":
			if mode == "badturn" {
				result = json.RawMessage(`{"turn":{"id":"","items":[],"status":"inProgress"}}`)
			}
		case "turn/steer":
			if mode == "badsteer" {
				result = json.RawMessage(`{"turnId":"another-turn"}`)
			}
		}
		if len(result) == 0 {
			return 3
		}
		_ = enc.Encode(map[string]any{"id": req.ID, "result": result})
		if (req.Method == "turn/start" && mode == "complete") || req.Method == "turn/interrupt" {
			var done map[string]any
			_ = json.Unmarshal(tape["turn/completed"], &done)
			if req.Method == "turn/interrupt" {
				done["turn"].(map[string]any)["status"] = "interrupted"
			}
			_ = enc.Encode(map[string]any{"method": "turn/completed", "params": done})
		}
	}
	return 0
}

func TestPinnedResponseAndNotificationContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/replay.json")
	if err != nil {
		t.Fatal(err)
	}
	var tape map[string]any
	if err := json.Unmarshal(raw, &tape); err != nil {
		t.Fatal(err)
	}
	for method, definition := range map[string]string{"initialize": "InitializeResponse", "thread/start": "v2/ThreadStartResponse", "turn/start": "v2/TurnStartResponse", "turn/steer": "v2/TurnSteerResponse", "turn/interrupt": "v2/TurnInterruptResponse", "turn/completed": "v2/TurnCompletedNotification"} {
		schema := pinnedSchema(t, definition)
		if err := schema.Validate(tape[method]); err != nil {
			t.Fatalf("%s: %v", method, err)
		}
	}
	thread := tape["thread/start"].(map[string]any)["thread"]
	turn := tape["turn/completed"].(map[string]any)["turn"]
	item := turn.(map[string]any)["items"].([]any)[0]
	for definition, value := range map[string]any{
		"v2/ThreadResumeResponse":    tape["thread/start"],
		"v2/ThreadReadResponse":      map[string]any{"thread": thread},
		"v2/ThreadTurnsListResponse": map[string]any{"data": []any{turn}},
		"v2/ThreadItemsListResponse": map[string]any{"data": []any{map[string]any{"turnId": "turn-fixture", "item": item}}},
		"ClientNotification":         map[string]any{"method": "initialized"},
	} {
		if err := pinnedSchema(t, definition).Validate(value); err != nil {
			t.Fatalf("%s: %v", definition, err)
		}
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("result.json", bytes.NewReader(ResultSchema())); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("result.json")
	if err != nil {
		t.Fatal(err)
	}
	var candidate any
	if err := json.Unmarshal([]byte(item.(map[string]any)["text"].(string)), &candidate); err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(candidate); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationsAreBoundAndApprovalsRefused(t *testing.T) {
	c := fixtureConfig(t, "running")
	a := New(c)
	defer a.Close()
	a.state = State{Version: Version, ThreadID: "thread-fixture", TurnID: "turn-fixture", SessionID: c.SessionID, Directory: c.Directory, Pending: true, SteerID: "delivery-1"}
	a.active = true
	for _, raw := range []string{`{"threadId":"another-thread","turn":{"id":"turn-fixture","status":"completed","items":[]}}`, `{"threadId":"thread-fixture","turn":{"id":"another-turn","status":"completed","items":[]}}`} {
		a.notification("turn/completed", json.RawMessage(raw))
	}
	for i := 0; i < 1000; i++ {
		a.notification("item/agentMessage/delta", json.RawMessage(`{"threadId":"thread-fixture","turnId":"turn-fixture","delta":"text"}`))
	}
	select {
	case <-a.Events():
		t.Fatal("unrelated notifications accepted")
	default:
	}
	a.notification("item/completed", json.RawMessage(`{"threadId":"thread-fixture","turnId":"turn-fixture","item":{"type":"userMessage","id":"item-1","clientId":"delivery-1","content":[]}}`))
	if e := <-a.Events(); e.ConfirmedInput != "delivery-1" || a.Snapshot().SteerID != "" {
		t.Fatal("history confirmation lost")
	}
	for _, method := range []string{"item/commandExecution/requestApproval", "account/chatgptAuthTokens/refresh", "item/tool/requestUserInput"} {
		_, err := a.handle(context.Background(), nil, &jsonrpc2.Request{Method: method})
		var rpc *jsonrpc2.Error
		if !errors.As(err, &rpc) || rpc.Code != jsonrpc2.CodeMethodNotFound {
			t.Fatalf("unattended request accepted: %s", method)
		}
	}
}

func TestEnvironmentExcludesDaemonCredentials(t *testing.T) {
	for _, key := range []string{"BATON_CONTROL_TOKEN", "BATON_DATABASE_URL", "BATON_NODE_SIGNING_KEY", "OP_SERVICE_ACCOUNT_TOKEN"} {
		t.Setenv(key, "must-not-inherit")
	}
	a := New(Config{Home: t.TempDir(), ContextFile: "context-path"})
	defer a.Close()
	for _, value := range a.environment() {
		if strings.Contains(value, "must-not-inherit") {
			t.Fatal("daemon credential inherited")
		}
	}
}

func fixtureConfig(t *testing.T, mode string) Config {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	tape, err := filepath.Abs("testdata/replay.json")
	if err != nil {
		t.Fatal(err)
	}
	env := []string{"BATON_CODEX_FIXTURE=1", "FIXTURE_TAPE=" + tape, "FIXTURE_LOG=" + filepath.Join(dir, "requests.jsonl"), "FIXTURE_MODE=" + mode, "FIXTURE_CWD=" + dir}
	for _, key := range []string{"PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"} {
		if val, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+val)
		}
	}
	return Config{Binary: binary, Directory: dir, Home: dir, StatePath: filepath.Join(dir, "state.json"), SessionID: "session-fixture", Model: "fixture-model", Env: env}
}

func settled(t *testing.T, a *Adapter) Event {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case e := <-a.Events():
			if e.Settled || e.Uncertain {
				return e
			}
		case <-timer.C:
			t.Fatal("no terminal event")
			return Event{}
		}
	}
}

func TestReplayCompleteAndResume(t *testing.T) {
	c := fixtureConfig(t, "complete")
	a := New(c)
	defer a.Close()
	ctx := context.Background()
	if err := a.CreateSession(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.StartTask(ctx, "operation-1", "task"); err != nil {
		t.Fatal(err)
	}
	e := settled(t, a)
	if !e.Settled || e.Uncertain {
		t.Fatalf("terminal flags: %+v", e)
	}
	if _, err := task.ParseCandidate(e.Final); err != nil {
		t.Fatal(err)
	}
	if err := a.StartTask(ctx, "operation-1", "must not replay"); !errors.Is(err, ErrUncertain) {
		t.Fatalf("duplicate: %v", err)
	}
	_ = a.Close()
	b := New(c)
	defer b.Close()
	if err := b.Attach(ctx); err != nil {
		t.Fatal(err)
	}
	if e := settled(t, b); !e.Settled {
		t.Fatal("history did not prove completion")
	}
	if page, err := b.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
		t.Fatal("history unavailable", err)
	}
	validateRequests(t, c)
}

func TestCanonicalDirectoryRecovery(t *testing.T) {
	c := fixtureConfig(t, "complete")
	original := c.Directory
	link := filepath.Join(t.TempDir(), "workspace")
	if err := os.Symlink(original, link); err != nil {
		t.Skip("directory symlink unavailable")
	}
	c.Directory = link
	for i, env := range c.Env {
		if strings.HasPrefix(env, "FIXTURE_CWD=") {
			c.Env[i] = "FIXTURE_CWD=" + link
		}
	}
	a := New(c)
	ctx := context.Background()
	if err := a.CreateSession(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.StartTask(ctx, "operation-1", "task"); err != nil {
		t.Fatal(err)
	}
	settled(t, a)
	_ = a.Close()
	b := New(c)
	if err := b.Attach(ctx); err != nil {
		t.Fatal(err)
	}
	settled(t, b)
	_ = b.Close()
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Fatal(err)
	}
	d := New(c)
	defer d.Close()
	if err := d.Attach(ctx); !errors.Is(err, ErrHistoryMissing) {
		t.Fatal("retargeted working directory accepted", err)
	}
}

func TestReplayInterruptAndSteer(t *testing.T) {
	c := fixtureConfig(t, "running")
	a := New(c)
	defer a.Close()
	ctx := context.Background()
	if err := a.CreateSession(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.StartTask(ctx, "operation-1", "task"); err != nil {
		t.Fatal(err)
	}
	if err := a.SendInput(ctx, "input-2", "more context"); err != nil {
		t.Fatal(err)
	}
	if err := a.SendInput(ctx, "input-2", "must not replay"); !errors.Is(err, ErrUncertain) {
		t.Fatal(err)
	}
	stopped, known, err := a.Interrupt(ctx)
	if err != nil || stopped || known {
		t.Fatalf("ACK mistaken for stop: %v %v %v", stopped, known, err)
	}
	if e := settled(t, a); !e.Uncertain || e.Settled {
		t.Fatal("interrupted work must remain unverified")
	}
	validateRequests(t, c)
}

func TestReplayMissingAndIncompatibleNeverCreate(t *testing.T) {
	for _, mode := range []string{"missing", "incompatible"} {
		t.Run(mode, func(t *testing.T) {
			c := fixtureConfig(t, mode)
			s := State{Version: Version, ThreadID: "thread-fixture", Directory: c.Directory, SessionID: c.SessionID}
			raw, _ := json.Marshal(s)
			if err := privatefile.WriteFile(c.StatePath, raw); err != nil {
				t.Fatal(err)
			}
			a := New(c)
			defer a.Close()
			err := a.Attach(context.Background())
			want := ErrHistoryMissing
			if mode == "incompatible" {
				want = ErrIncompatible
			}
			if !errors.Is(err, want) {
				t.Fatal(err)
			}
			requests, _ := os.ReadFile(filepath.Join(c.Directory, "requests.jsonl"))
			if strings.Contains(string(requests), "thread/start") {
				t.Fatal("replacement thread created")
			}
		})
	}
}

func TestReplayUncertainInputCannotRetry(t *testing.T) {
	c := fixtureConfig(t, "disconnect")
	a := New(c)
	defer a.Close()
	ctx := context.Background()
	if err := a.CreateSession(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.StartTask(ctx, "operation-1", "task"); err == nil {
		t.Fatal("lost response accepted")
	}
	if err := a.StartTask(ctx, "operation-1", "task"); !errors.Is(err, ErrUncertain) {
		t.Fatal(err)
	}
	_ = a.Close()
	b := New(c)
	defer b.Close()
	if err := b.Attach(ctx); !errors.Is(err, ErrUncertain) {
		t.Fatal(err)
	}
}

func validateRequests(t *testing.T, c Config) {
	t.Helper()
	schema := pinnedSchema(t, "ClientRequest")
	raw, err := os.ReadFile(filepath.Join(c.Directory, "requests.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var v map[string]any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatal(err)
		}
		if _, ok := v["id"]; !ok {
			continue
		}
		if err := schema.Validate(v); err != nil {
			t.Fatalf("%s violates pinned schema: %v", v["method"], err)
		}
		if params, ok := v["params"].(map[string]any); ok {
			if id, present := params["threadId"]; present && id != "thread-fixture" {
				t.Fatal("request changed thread identity")
			}
			if id, present := params["expectedTurnId"]; present && id != "turn-fixture" {
				t.Fatal("steer changed turn identity")
			}
			if id, present := params["turnId"]; present && id != "turn-fixture" {
				t.Fatal("interrupt changed turn identity")
			}
		}
	}
}

func TestReplayRecoveryPaginationAndGaps(t *testing.T) {
	for _, mode := range []string{"paged", "absentturn", "cycle", "missing-items"} {
		t.Run(mode, func(t *testing.T) {
			c := fixtureConfig(t, mode)
			a := New(c)
			ctx := context.Background()
			if err := a.CreateSession(ctx); err != nil {
				t.Fatal(err)
			}
			if err := a.StartTask(ctx, "operation-1", "task"); err != nil {
				t.Fatal(err)
			}
			_ = a.Close()
			b := New(c)
			defer b.Close()
			err := b.Attach(ctx)
			switch mode {
			case "paged":
				if err != nil {
					t.Fatal(err)
				}
				if e := settled(t, b); !e.Settled {
					t.Fatal("paged recovery did not settle")
				}
			case "cycle":
				if !errors.Is(err, ErrIncompatible) {
					t.Fatal(err)
				}
			default:
				if !errors.Is(err, ErrHistoryMissing) {
					t.Fatal(err)
				}
			}
			validateRequests(t, c)
		})
	}
}

func TestReplayVersionAndMutationResponseGuards(t *testing.T) {
	for _, mode := range []string{"wrongversion", "badturn", "badsteer"} {
		t.Run(mode, func(t *testing.T) {
			c := fixtureConfig(t, mode)
			a := New(c)
			defer a.Close()
			ctx := context.Background()
			err := a.CreateSession(ctx)
			if mode == "wrongversion" {
				if !errors.Is(err, ErrIncompatible) {
					t.Fatal(err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			err = a.StartTask(ctx, "operation-1", "task")
			if mode == "badturn" {
				if !errors.Is(err, ErrIncompatible) {
					t.Fatal(err)
				}
				if err := a.StartTask(ctx, "operation-1", "retry"); !errors.Is(err, ErrUncertain) {
					t.Fatal(err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := a.SendInput(ctx, "input-2", "extra"); !errors.Is(err, ErrIncompatible) {
				t.Fatal(err)
			}
			if err := a.SendInput(ctx, "input-2", "retry"); !errors.Is(err, ErrUncertain) {
				t.Fatal(err)
			}
		})
	}
}

func pinnedSchema(t *testing.T, definition string) *jsonschema.Schema {
	t.Helper()
	raw, err := os.ReadFile("testdata/schema-0.162.1.json")
	if err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	const source = "https://baton.invalid/codex-0.162.1.json"
	if err := compiler.AddResource(source, bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(source + "#/definitions/" + definition)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func TestCodexInitializeWithoutModel(t *testing.T) {
	if os.Getenv("BATON_CODEX_PROBE") != "1" {
		t.Skip("explicit no-model CLI probe only")
	}
	dir := t.TempDir()
	a := New(Config{Directory: dir, Home: dir, StatePath: filepath.Join(dir, "state.json")})
	defer a.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := a.connect(ctx); err != nil {
		t.Fatal(err)
	}
	t.Logf("CLI=%s initialize=passed; model tasks not run", Version)
}

func TestBrowserDeltaUsesSeparateBoundedQueue(t *testing.T) {
	a := New(Config{})
	defer a.Close()
	a.mu.Lock()
	a.state.ThreadID, a.state.TurnID = "thread", "turn"
	raw := json.RawMessage(`{"threadId":"thread","turnId":"turn","delta":"输出"}`)
	for i := 0; i < 1000; i++ {
		if _, err := a.handle(context.Background(), nil, &jsonrpc2.Request{Method: "item/agentMessage/delta", Params: &raw, Notif: true}); err != nil {
			t.Fatal(err)
		}
	}
	a.mu.Unlock()
	deadline := time.Now().Add(time.Second)
	var text string
	var gap bool
	for time.Now().Before(deadline) {
		got, missed := a.DrainLive()
		text += got
		gap = gap || missed
		if text != "" && gap {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if text == "" || !gap {
		t.Fatal("增量没有进入有界输出缓存")
	}
	select {
	case <-a.closed:
		t.Fatal("慢输出订阅关闭了 Agent")
	default:
	}
}

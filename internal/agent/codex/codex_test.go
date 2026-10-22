package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v5"
	"github.com/sourcegraph/jsonrpc2"
)

func TestNotificationsAreBoundAndApprovalsRefused(t *testing.T) {
	c := Config{Directory: t.TempDir(), SessionID: "session-unit", StatePath: filepath.Join(t.TempDir(), "state.json")}
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
	if len(a.Drain()) != 0 {
		t.Fatal("unrelated notifications accepted")
	}
	a.notification("item/completed", json.RawMessage(`{"threadId":"thread-fixture","turnId":"turn-fixture","item":{"type":"agentMessage","id":"reply","text":"reply"}}`))
	events := a.Drain()
	if len(events) != 2 || events[1].Kind != agent.EventReply || events[1].Content != "reply" {
		t.Fatal(events)
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
	for _, key := range []string{"BATON_CONTROL_TOKEN", "BATON_DATABASE_URL", "BATON_NODE_SIGNING_KEY"} {
		t.Setenv(key, "must-not-inherit")
	}
	a := New(Config{Home: t.TempDir()})
	defer a.Close()
	for _, value := range a.environment() {
		if strings.Contains(value, "must-not-inherit") {
			t.Fatal("daemon credential inherited")
		}
	}
}

func pinnedSchema(t *testing.T, definition string) *jsonschema.Schema {
	t.Helper()
	raw, err := os.ReadFile("testdata/schema-" + Version + ".json")
	if err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	const source = "https://baton.invalid/codex-" + Version + ".json"
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

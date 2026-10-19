package replay

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func synthetic(agent string, entries ...RawEntry) RawRecording {
	return RawRecording{Header: RawHeader{Type: "raw_start", Version: 1, Transcript: Header{Agent: agent, Protocol: map[string]string{"pi": "pi-rpc-jsonl", "codex": "codex-app-server-jsonrpc"}[agent], Scenario: "simple", Source: "synthetic"}, Bindings: map[string]string{"<workspace>": "/test/work", "<home>": "/test/home", "<session_dir>": "/test/sessions", "<context_file>": "/test/work/context.json"}, Hostname: "recording-host", Username: "recording-user"}, Entries: entries}
}
func rawEntry(kind string, process int, data string) RawEntry {
	return RawEntry{Type: kind, Process: process, Data: []byte(data + "\n")}
}
func start(process int, args ...string) RawEntry {
	return RawEntry{Type: "process_start", Process: process, Args: args}
}
func finish(process int) RawEntry { return RawEntry{Type: "runtime_exit", Process: process} }
func jsonText(v any) string       { b, _ := marshalUnescaped(v); return string(b) }

func TestNormalizeKiroACP(t *testing.T) {
	raw := synthetic("kiro", start(1, "acp", "--agent-engine=v3"),
		rawEntry("stdin", 1, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`),
		rawEntry("stdout", 1, `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[{"id":"private"}],"agentCapabilities":{"loadSession":true,"_meta":{"kiro":{"logging":{"logDir":"/Users/recording-user/logs"},"extensionMethods":["_kiro/session/history"]}}}}}`),
		rawEntry("stdin", 1, `{"id":2,"method":"session/new","params":{"cwd":"/test/work","mcpServers":[]}}`),
		rawEntry("stdout", 1, `{"id":2,"result":{"sessionId":"native-parent"}}`),
		rawEntry("stdin", 1, `{"id":3,"method":"session/prompt","params":{"sessionId":"native-parent","prompt":[{"type":"text","text":"task-private"}]}}`),
		rawEntry("stdout", 1, `{"method":"session/update","params":{"sessionId":"native-parent","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"general-task-execution"}]}}}`),
		rawEntry("stdout", 1, `{"id":9,"method":"session/request_permission","params":{"sessionId":"native-parent","options":[{"optionId":"allow","kind":"allow_once"}]}}`),
		rawEntry("stdin", 1, `{"id":9,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}`),
		rawEntry("stdout", 1, `{"method":"session/update","params":{"sessionId":"native-parent","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"model output"}}}}`),
		rawEntry("stdout", 1, `{"id":3,"result":{"stopReason":"end_turn"}}`),
		start(2, "acp", "--agent-engine=v3"),
		rawEntry("stdin", 2, `{"id":1,"method":"session/new","params":{"cwd":"/test/work"}}`),
		rawEntry("stdout", 2, `{"id":1,"result":{"sessionId":"native-child"}}`),
		rawEntry("stdout", 2, `{"method":"session/update","params":{"sessionId":"native-child","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"discard child"}}}}`), finish(2), finish(1))
	raw.Header.Transcript.Protocol = "acp-jsonrpc"
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	all := jsonText(tape)
	for _, private := range []string{"native-parent", "native-child", "task-private", "recording-user", "discard child", "general-task-execution"} {
		if strings.Contains(all, private) {
			t.Fatalf("未处理 %s", private)
		}
	}
	if !strings.Contains(all, "native-session-1") || !strings.Contains(all, "model output") {
		t.Fatal(all)
	}
	found := false
	for _, e := range tape.Entries {
		if e.Type == "expect_outbound" && strings.Contains(string(e.Frame), "selected") {
			v, _ := decode(e.Frame)
			if child(v, "id") != json.Number("9") {
				t.Fatal("服务器请求 ID 被改写")
			}
			found = true
		}
	}
	if !found || tape.Header.DroppedFrames < 3 {
		t.Fatal("过滤计数或双向请求缺失")
	}
}

func TestNormalizeCodexRulesAndDirections(t *testing.T) {
	raw := synthetic("codex",
		start(1, "app-server", "--stdio"),
		rawEntry("stdin", 1, `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"baton","version":"secret-init"}}}`),
		rawEntry("stdout", 1, `{"id":1,"result":{"userAgent":"recording-host recording-user","platformOs":"macos","codexHome":"/test/home","authStatus":"secret"}}`),
		rawEntry("stdin", 1, `{"id":2,"method":"account/read","params":{}}`),
		rawEntry("stdout", 1, `{"id":2,"result":{"account":{"email":"private"}}}`),
		rawEntry("stdout", 1, `{"method":"account/updated","params":{"account":"private"}}`),
		rawEntry("stdout", 1, `{"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"recording-host","installationId":"install-secret"}}`),
		rawEntry("stdin", 1, `{"id":3,"method":"thread/start","params":{"cwd":"/test/work","developerInstructions":"system-secret","config":{"private":"init-secret"}}}`),
		rawEntry("stdout", 1, `{"id":3,"result":{"thread":{"id":"native-thread","sessionId":"native-session"}}}`),
		rawEntry("stdin", 1, `{"id":4,"method":"turn/start","params":{"threadId":"native-thread","clientUserMessageId":"execution-random:1","input":[{"type":"text","text":"task-secret"}],"outputSchema":{"secret":"schema"}}}`),
		rawEntry("stdout", 1, `{"id":4,"result":{"turn":{"id":"native-turn"}}}`),
		rawEntry("stdout", 1, `{"id":7,"method":"item/tool/call","params":{"threadId":"native-thread","itemId":"native-item"}}`),
		rawEntry("stdin", 1, `{"id":7,"result":{"output":"tool output"}}`),
		rawEntry("stdout", 1, `{"method":"turn/completed","params":{"threadId":"native-thread","turn":{"id":"native-turn","items":[{"id":"native-item","type":"agentMessage","text":"  { \"summary\": \"model output\", \"status\": \"completed\" }  "}]}}}`),
		finish(1))
	t1, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	if t1.Header.DroppedFrames != 4 || t1.Header.Normalization != "v1" {
		t.Fatal(t1.Header)
	}
	all := jsonText(t1)
	for _, secret := range []string{"secret-init", "system-secret", "init-secret", "task-secret", "native-thread", "native-turn", "native-item", "recording-host", "recording-user", "install-secret"} {
		if strings.Contains(all, secret) {
			t.Fatalf("未规范化 %s", secret)
		}
	}
	if !strings.Contains(all, "<$execution_id_1>:1") || !strings.Contains(all, "thread-1") {
		t.Fatal(all)
	}
	var request, response any
	for _, e := range t1.Entries {
		if e.Label == "event:item/tool/call" {
			request, _ = decode(e.Frame)
		}
		if e.Type == "expect_outbound" && strings.Contains(string(e.Frame), "tool output") {
			response, _ = decode(e.Frame)
		}
		if e.Label == "event:turn/completed" {
			v, _ := decode(e.Frame)
			items := child(v, "params", "turn", "items").([]any)
			if str(child(items[0], "text")) != "  { \"summary\": \"model output\", \"status\": \"completed\" }  " {
				t.Fatal("模型文本被重写")
			}
		}
	}
	if child(request, "id") != json.Number("7") || child(response, "id") != json.Number("7") {
		t.Fatalf("Agent 请求 id 被捕获: %v %v", request, response)
	}
}

func TestNormalizeDeliveryAndWindowsBindings(t *testing.T) {
	raw := synthetic("pi", start(1, "--session-id", "session-random", "--session-dir", `C:\Users\example\sessions`, "--append-system-prompt", "system-secret"),
		rawEntry("stdin", 1, `{"id":"baton-1","type":"prompt","message":"{\"delivery_id\":\"delivery-random\",\"result\":{\"summary\":\"child result\"},\"file\":\"C:\\\\Users\\\\example\\\\sessions\\\\a.json\"}"}`),
		rawEntry("stdout", 1, `{"id":"baton-1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}`),
		RawEntry{Type: "native_history", Process: 1, Path: `C:\Users\example\sessions\session-random.jsonl`, Data: []byte("{\"type\":\"session\",\"id\":\"session-random\",\"cwd\":\"/test/work\"}\n{\"type\":\"message\",\"id\":\"entry-random\",\"message\":{\"role\":\"user\",\"content\":\"{\\\"delivery_id\\\":\\\"delivery-random\\\",\\\"summary\\\":\\\"child result\\\"}\"}}\n")},
		rawEntry("stdout", 1, `{"type":"agent_settled","sessionId":"session-random"}`), finish(1))
	raw.Header.Bindings["<session_dir>"] = `C:\Users\example\sessions`
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	all := jsonText(tape)
	if strings.Contains(all, "delivery-random") || strings.Contains(all, "session-random") || strings.Contains(all, "system-secret") {
		t.Fatal(all)
	}
	if !strings.Contains(all, "child result") || !strings.Contains(all, "<$delivery_id_1>") || !strings.Contains(all, "<session_dir>") {
		t.Fatal(all)
	}
	for _, e := range tape.Entries {
		if e.Type == "expect_outbound" {
			v, err := Expand(e.Frame, map[string]string{"<session_dir>": `D:\temp\sessions`}, map[string]any{"<$request_id_1>": "new-request", "<$delivery_id_1>": "new-delivery"})
			if err != nil || !json.Valid(v) {
				t.Fatalf("Windows 转义: %s %v", v, err)
			}
		}
	}
}

func TestNormalizeFirstSessionAndResume(t *testing.T) {
	for _, agent := range []string{"pi", "codex"} {
		t.Run(agent, func(t *testing.T) {
			var entries []RawEntry
			if agent == "pi" {
				entries = []RawEntry{start(1, "--version"), rawEntry("stdout", 1, "1.3.0"), finish(1), start(2, "--session-id", "parent-session"), rawEntry("stdout", 2, `{"type":"agent_start"}`), finish(2), start(3, "--session-id", "child-session"), rawEntry("stdin", 3, `{"type":"prompt","id":"baton-1","message":"child"}`), rawEntry("stdout", 3, `{"type":"agent_start"}`), rawEntry("stderr", 3, "child diagnostic"), finish(3), start(4, "--session", "/test/sessions/parent-session.jsonl"), rawEntry("stdout", 4, `{"type":"agent_settled"}`), finish(4)}
			} else {
				entries = []RawEntry{start(1, "app-server", "--stdio"), rawEntry("stdin", 1, `{"id":1,"method":"thread/start","params":{}}`), rawEntry("stdout", 1, `{"id":1,"result":{"thread":{"id":"parent-thread"}}}`), finish(1), start(2, "app-server", "--stdio"), rawEntry("stdin", 2, `{"id":1,"method":"thread/start","params":{}}`), rawEntry("stdout", 2, `{"id":1,"result":{"thread":{"id":"child-thread"}}}`), rawEntry("stderr", 2, "child diagnostic"), finish(2), start(3, "app-server", "--stdio"), rawEntry("stdin", 3, `{"id":1,"method":"thread/resume","params":{"threadId":"parent-thread"}}`), rawEntry("stdout", 3, `{"id":1,"result":{"thread":{"id":"parent-thread"}}}`), finish(3)}
			}
			tape, err := Normalize(synthetic(agent, entries...))
			if err != nil {
				t.Fatal(err)
			}
			if tape.Header.DroppedFrames != 3 {
				t.Fatal(tape.Header)
			}
			for _, e := range tape.Entries {
				if strings.Contains(jsonText(e), "child") {
					t.Fatal(e)
				}
			}
			var b bytes.Buffer
			if err := Write(&b, tape); err != nil {
				t.Fatal(err)
			}
			if _, err := Read(&b); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNormalizeTwoCodexSessionsInOneProcess(t *testing.T) {
	raw := synthetic("codex", start(1),
		rawEntry("stdin", 1, `{"id":1,"method":"thread/start","params":{}}`), rawEntry("stdout", 1, `{"id":1,"result":{"thread":{"id":"parent"}}}`),
		rawEntry("stdin", 1, `{"id":2,"method":"thread/start","params":{}}`), rawEntry("stdout", 1, `{"id":2,"result":{"thread":{"id":"child"}}}`),
		rawEntry("stdin", 1, `{"id":3,"method":"turn/start","params":{"threadId":"child"}}`), rawEntry("stdout", 1, `{"id":3,"result":{"turn":{"id":"child-turn"}}}`),
		rawEntry("stdout", 1, `{"method":"turn/completed","params":{"threadId":"child"}}`),
		rawEntry("stdout", 1, `{"method":"turn/completed","params":{"threadId":"parent"}}`), finish(1))
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tape.Header.DroppedFrames != 5 {
		t.Fatal(tape.Header)
	}
	if strings.Contains(jsonText(tape), "child") {
		t.Fatal(jsonText(tape))
	}
}

func TestNormalizeRefusesResidualsWithoutTouchingOutput(t *testing.T) {
	for _, value := range []string{"sk-test-key", "AKIA1234567890ABCDEF", "ghp_test123", "Bearer test-token", "-----BEGIN RSA PRIVATE KEY-----", "/Users/example/file", "/home/example/file", `C:\Users\example\file`, "recording-host", "recording-user"} {
		t.Run(strings.ReplaceAll(value, "/", "_"), func(t *testing.T) {
			raw := synthetic("codex", start(1), rawEntry("stdout", 1, jsonText(map[string]any{"method": "item/output", "params": map[string]string{"output": value}})), finish(1))
			dir := t.TempDir()
			input, output := filepath.Join(dir, "raw.ndjson"), filepath.Join(dir, "out.ndjson")
			var b bytes.Buffer
			enc := json.NewEncoder(&b)
			enc.Encode(raw.Header)
			for _, e := range raw.Entries {
				enc.Encode(e)
			}
			os.WriteFile(input, b.Bytes(), 0600)
			os.WriteFile(output, []byte("keep"), 0600)
			err := NormalizeFile(input, output)
			if err == nil || !strings.Contains(err.Error(), "行 3 $.frame.params.output") {
				t.Fatalf("应给出残留位置: %v", err)
			}
			if strings.Contains(err.Error(), value) {
				t.Fatal("错误信息泄露原始内容")
			}
			after, _ := os.ReadFile(output)
			if string(after) != "keep" {
				t.Fatal("拒绝写出后覆盖了原文件")
			}
			os.Remove(output)
			if err := NormalizeFile(input, output); err == nil {
				t.Fatal("允许残留")
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatal("拒绝后创建了输出")
			}
		})
	}
}

func TestNormalizeACPRequiresPolicy(t *testing.T) {
	if _, err := Normalize(synthetic("acp", start(1))); err == nil {
		t.Fatal("ACP 不应隐式套用规则")
	}
}

func TestNormalizeAgentAuthRequestAndNestedResult(t *testing.T) {
	raw := synthetic("codex", start(1),
		rawEntry("stdout", 1, `{"id":1,"method":"account/chatgptAuthTokens/refresh","params":{"account":"private"}}`),
		rawEntry("stdin", 1, `{"id":1,"result":{"accessToken":"private"}}`),
		rawEntry("stdout", 1, `{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"{\"role\":\"user\",\"content\":\"model text\",\"account\":\"business value\"}"}}}`), finish(1))
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tape.Header.DroppedFrames != 2 {
		t.Fatal(tape.Header)
	}
	v, err := decode(tape.Entries[1].Frame)
	if err != nil {
		t.Fatal(err)
	}
	if str(child(v, "params", "item", "text")) != `{"role":"user","content":"model text","account":"business value"}` {
		t.Fatal(v)
	}
}

func TestNormalizeKeepsAgentStringRequestID(t *testing.T) {
	raw := synthetic("codex", start(1),
		rawEntry("stdin", 1, `{"id":1,"method":"thread/start","params":{}}`), rawEntry("stdout", 1, `{"id":1,"result":{"thread":{"id":"same-id"}}}`),
		rawEntry("stdout", 1, `{"id":"same-id","method":"item/tool/call","params":{"threadId":"same-id"}}`), rawEntry("stdin", 1, `{"id":"same-id","error":{"code":-32601,"message":"refused"}}`), finish(1))
	tape, err := Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range tape.Entries {
		if e.Label == "event:item/tool/call" || e.Label == "notification:item/tool/call" {
			v, _ := decode(e.Frame)
			if child(v, "id") != "same-id" {
				t.Fatal(v)
			}
		}
	}
}

func TestNestedDeliveryMatchAndExpand(t *testing.T) {
	expected := json.RawMessage(`{"message":"{\"delivery_id\":\"<$delivery_id>\",\"file\":\"<workspace>\"}"}`)
	actual := json.RawMessage(`{"message":"{\"file\":\"C:\\\\temp\\\\work\",\"delivery_id\":\"new-delivery\"}"}`)
	bindings := map[string]string{"<workspace>": `C:\temp\work`}
	captures := map[string]any{}
	if err := Match(expected, actual, bindings, captures); err != nil {
		t.Fatal(err)
	}
	out, err := Expand(expected, bindings, captures)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := decode(out)
	nested, err := decode([]byte(str(child(v, "message"))))
	if err != nil || child(nested, "file") != bindings["<workspace>"] || child(nested, "delivery_id") != "new-delivery" {
		t.Fatalf("嵌套展开: %s %v", out, err)
	}
}

package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"testing"

	"baton/internal/agent/codex/replaytest"
	"baton/internal/privatefile"
	"github.com/sourcegraph/jsonrpc2"
)

// 内存连接只检查分页、标识与分帧等局部逻辑；完整流程由录制转录驱动。
func unitRPC(t *testing.T, a *Adapter, handle func(string, json.RawMessage) (any, error)) {
	t.Helper()
	left, right := net.Pipe()
	server := jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(left, lineCodec{}), jsonrpc2.HandlerWithError(func(_ context.Context, _ *jsonrpc2.Conn, r *jsonrpc2.Request) (any, error) {
		if r.Notif {
			return nil, nil
		}
		return handle(r.Method, *r.Params)
	}))
	a.conn = jsonrpc2.NewConn(context.Background(), jsonrpc2.NewBufferedStream(right, lineCodec{}), jsonrpc2.HandlerWithError(a.handle))
	t.Cleanup(func() { a.Close(); server.Close() })
}
func TestRecoveryPaginationAndGuards(t *testing.T) {
	tape := replaytest.Load(t, "testdata/replay/restore_load_only.ndjson")
	for _, name := range []string{"paged", "previous-version", "absentturn", "cycle", "missing-items", "incompatible", "wrong-thread"} {
		t.Run(name, func(t *testing.T) {
			c := Config{Directory: t.TempDir(), SessionID: "unit", StatePath: filepath.Join(t.TempDir(), "state.json"), Restore: true}
			c.Directory, _ = filepath.EvalSymlinks(c.Directory)
			s := State{Version: Version, ThreadID: "thread-1", TurnID: "turn-1", Directory: c.Directory, SessionID: c.SessionID}
			if name == "previous-version" {
				s.Version = "0.162.1"
			}
			raw, _ := json.Marshal(s)
			if err := privatefile.WriteFile(c.StatePath, raw); err != nil {
				t.Fatal(err)
			}
			a := New(c)
			turnCalls, itemCalls := 0, 0
			unitRPC(t, a, func(method string, params json.RawMessage) (any, error) {
				switch method {
				case "thread/read":
					id := "thread-1"
					if name == "wrong-thread" {
						id = "other"
					}
					return map[string]any{"thread": map[string]any{"id": id, "cwd": c.Directory}}, nil
				case "thread/turns/list":
					turnCalls++
					if name == "absentturn" {
						return map[string]any{"data": []any{}}, nil
					}
					if name == "cycle" || (name == "paged" && turnCalls == 1) {
						return map[string]any{"data": []any{}, "nextCursor": "next"}, nil
					}
					result := replaytest.Frame(t, tape, "response:thread/turns/list")["result"].(map[string]any)
					for _, v := range result["data"].([]any) {
						v.(map[string]any)["items"] = []any{}
					}
					return result, nil
				case "thread/resume":
					if name == "incompatible" {
						return nil, &jsonrpc2.Error{Code: -32601, Message: "unsupported"}
					}
					return map[string]any{"thread": map[string]any{"id": "thread-1"}}, nil
				case "thread/items/list":
					itemCalls++
					if name == "missing-items" {
						return map[string]any{"data": []any{}}, nil
					}
					if name == "paged" && itemCalls == 1 {
						return map[string]any{"data": []any{}, "nextCursor": "next"}, nil
					}
					return replaytest.Frame(t, tape, "response:thread/items/list:5")["result"], nil
				default:
					t.Errorf("恢复发送额外请求 %s", method)
					return nil, &jsonrpc2.Error{Code: -32601}
				}
			})
			err := a.Attach(context.Background())
			switch name {
			case "paged", "previous-version":
				if err != nil {
					t.Fatal(err)
				}
				successful(t, awaitOutput(t, a))
				if name == "paged" && (turnCalls != 2 || itemCalls != 2) {
					t.Fatal("分页未执行")
				}
				if a.Snapshot().Version != s.Version {
					t.Fatal("恢复改写了原生映射的创建版本")
				}
			case "cycle", "incompatible":
				if !errors.Is(err, ErrIncompatible) {
					t.Fatal(err)
				}
			default:
				if !errors.Is(err, ErrHistoryMissing) {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestHistoryContainsExactIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, item    string
		queried, want bool
	}{
		{"client-id", `{"type":"userMessage","clientId":"delivery-1"}`, false, true},
		{"user-envelope", `{"type":"userMessage","content":[{"text":"{\"delivery_id\":\"delivery-1\"}"}]}`, false, true},
		{"successful-query", `{"type":"commandExecution","exitCode":0,"aggregatedOutput":"{\"delivery_id\":\"delivery-1\"}"}`, true, true},
		{"failed-query", `{"type":"commandExecution","exitCode":1,"aggregatedOutput":"{\"delivery_id\":\"delivery-1\"}"}`, true, false},
		{"assistant", `{"type":"agentMessage","text":"{\"delivery_id\":\"delivery-1\"}"}`, false, false},
		{"wrong-role", `{"type":"userMessage","clientId":"delivery-1"}`, true, false},
		{"substring", `{"type":"userMessage","clientId":"delivery-10","content":[{"text":"{\"delivery_id\":\"delivery-10\"}"}]}`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := New(Config{})
			a.state.ThreadID = "thread-1"
			calls := 0
			unitRPC(t, a, func(method string, _ json.RawMessage) (any, error) {
				if method != "thread/items/list" {
					t.Errorf("额外请求 %s", method)
				}
				calls++
				if calls == 1 {
					return map[string]any{"data": []any{}, "nextCursor": "next"}, nil
				}
				return json.RawMessage(`{"data":[{"turnId":"turn-1","item":` + tc.item + `}]}`), nil
			})
			found, err := a.HistoryContains("delivery-1", tc.queried)
			if err != nil || found != tc.want || calls != 2 {
				t.Fatalf("历史确认: %v %v calls=%d", found, err, calls)
			}
		})
	}
}
func TestCodexLFFramingLimits(t *testing.T) {
	codec := lineCodec{}
	// 读取边界与帧上限无法由逐帧转录表达。
	raw := `{"text":"a` + "\u2028\u2029" + `b"}` + "\n"
	var got map[string]string
	if err := codec.ReadObject(bufio.NewReaderSize(strings.NewReader(raw), 1), &got); err != nil || got["text"] != "a\u2028\u2029b" {
		t.Fatal(got, err)
	}
	if err := codec.ReadObject(bufio.NewReader(strings.NewReader(strings.Repeat("x", maxFrame+1)+"\n")), &got); err == nil {
		t.Fatal("超限帧被接受")
	}
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	if err := codec.WriteObject(w, map[string]string{"text": "一行"}); err != nil {
		t.Fatal(err)
	}
	w.Flush()
	if bytes.Count(buf.Bytes(), []byte{'\n'}) != 1 {
		t.Fatal("出站帧不是单行")
	}
}
func TestRecordedPinnedContracts(t *testing.T) {
	tape := replaytest.Load(t, "testdata/replay/restore_load_only.ndjson")
	for label, definition := range map[string]string{"response:thread/start": "v2/ThreadStartResponse", "response:turn/start": "v2/TurnStartResponse", "response:turn/steer": "v2/TurnSteerResponse", "response:thread/read": "v2/ThreadReadResponse", "response:thread/turns/list": "v2/ThreadTurnsListResponse", "response:thread/resume": "v2/ThreadResumeResponse", "response:thread/items/list": "v2/ThreadItemsListResponse"} {
		if err := pinnedSchema(t, definition).Validate(replaytest.Frame(t, tape, label)["result"]); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
	}
	interrupt := replaytest.Load(t, "testdata/replay/interrupt_mid_tool.ndjson")
	if err := pinnedSchema(t, "v2/TurnInterruptResponse").Validate(replaytest.Frame(t, interrupt, "response:turn/interrupt")["result"]); err != nil {
		t.Fatal(err)
	}
	if err := pinnedSchema(t, "v2/TurnCompletedNotification").Validate(replaytest.Frame(t, tape, "event:turn/completed")["params"]); err != nil {
		t.Fatal(err)
	}
	if err := pinnedSchema(t, "ClientNotification").Validate(map[string]any{"method": "initialized"}); err != nil {
		t.Fatal(err)
	}

}

func TestRecordedToolInterruptFacts(t *testing.T) {
	tape := replaytest.Load(t, "testdata/replay/interrupt_mid_tool.ndjson")
	start := replaytest.CommandStartLabel(t, tape)
	positions := map[string]int{}
	for i, e := range tape.Entries {
		positions[e.Label] = i
	}
	if !(positions[start] < positions["request:turn/interrupt"] && positions["request:turn/interrupt"] < positions["response:turn/interrupt"] && positions["response:turn/interrupt"] < positions["event:turn/completed"]) {
		t.Fatal("录制没有按工具开始、中止请求、ACK、停止事实排序")
	}
	command := replaytest.Frame(t, tape, start)["params"].(map[string]any)
	request := replaytest.Frame(t, tape, "request:turn/interrupt")["params"].(map[string]any)
	completed := replaytest.Frame(t, tape, "event:turn/completed")["params"].(map[string]any)
	turn := completed["turn"].(map[string]any)
	if command["threadId"] != request["threadId"] || command["turnId"] != request["turnId"] || completed["threadId"] != request["threadId"] || turn["id"] != request["turnId"] || turn["status"] != "interrupted" {
		t.Fatal("工具开始与中止停止事实没有绑定同一回合")
	}
	commandID := command["item"].(map[string]any)["id"]
	for _, e := range tape.Entries[positions[start]+1 : positions["request:turn/interrupt"]] {
		var f struct {
			Method string
			Params struct{ Item struct{ ID string } }
		}
		if json.Unmarshal(e.Frame, &f) == nil && f.Method == "item/completed" && f.Params.Item.ID == commandID {
			t.Fatal("工具已经完成后才请求中止")
		}
	}
	if tape.Header.AgentVersion != Version {
		t.Fatal("工具中止录制不是当前 CLI 版本")
	}
	if err := pinnedSchema(t, "v2/ItemStartedNotification").Validate(command); err != nil {
		t.Fatal(err)
	}
}

func TestPendingInputRecoveryNeverResubmits(t *testing.T) {
	c := Config{Directory: t.TempDir(), SessionID: "unit", StatePath: filepath.Join(t.TempDir(), "state.json")}
	c.Directory, _ = filepath.EvalSymlinks(c.Directory)
	s := State{Version: Version, ThreadID: "thread-1", SessionID: c.SessionID, Directory: c.Directory, Pending: true, OperationID: "operation-1", Operations: []string{"operation-1"}}
	raw, _ := json.Marshal(s)
	if err := privatefile.WriteFile(c.StatePath, raw); err != nil {
		t.Fatal(err)
	}
	a := New(c)
	unitRPC(t, a, func(method string, _ json.RawMessage) (any, error) {
		if method != "thread/read" {
			t.Errorf("未确认输入恢复时发送了 %s", method)
		}
		return map[string]any{"thread": map[string]any{"id": "thread-1", "cwd": c.Directory}}, nil
	})
	if err := a.Attach(context.Background()); !errors.Is(err, ErrUncertain) {
		t.Fatal(err)
	}
}

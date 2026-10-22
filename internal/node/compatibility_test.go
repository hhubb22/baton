package node

import (
	"baton/internal/monotime"
	"baton/internal/protocol"
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func nodeCompatibilityBody(t *testing.T, value any, variant, required string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err = json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	switch variant {
	case "extra":
		body["future_field"] = map[string]any{"enabled": true}
	case "missing":
		delete(body, required)
	case "wrong_type":
		body[required] = []any{42}
	}
	raw, err = json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// compatibilityLoop 把给定回复交给真实 roundTrip 等待者，隔离各业务解码入口的检查。
func compatibilityLoop(t *testing.T, responses ...json.RawMessage) *runtimeRPC {
	t.Helper()
	ctx := t.Context()
	loop := newRuntimeRPC(nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer ws.CloseNow()
		index := 0
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var frame struct {
				Envelope protocol.Envelope `json:"envelope"`
			}
			if json.Unmarshal(raw, &frame) != nil {
				return
			}
			loop.mu.Lock()
			ch := loop.waiters[frame.Envelope.MessageID]
			loop.mu.Unlock()
			if ch != nil {
				response := responses[min(index, len(responses)-1)]
				index++
				ch <- append(json.RawMessage(nil), response...)
			}
		}
	}))
	t.Cleanup(server.Close)
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	loop.writer = newWSWriter(ws)
	return loop
}

func TestNodeReplyCompatibility(t *testing.T) {
	for _, variant := range []string{"extra", "missing", "wrong_type"} {
		t.Run(variant, func(t *testing.T) {
			raw := nodeCompatibilityBody(t, protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"known":42}`)}, variant, "type")
			loop := compatibilityLoop(t, raw)
			got := (&projectRuntimeManager{loop: loop}).call(t.Context(), protocol.ProjectRuntimeRequest{Operation: "bootstrap"})
			if got.OK != (variant == "extra") {
				t.Fatalf("Runtime 结果: %+v", got)
			}
			if got.OK && string(got.Data) != `{"known":42}` {
				t.Fatal("Runtime 回复内容改变")
			}
		})
	}
}

func TestNodeCommandCompatibility(t *testing.T) {
	for _, variant := range []string{"extra", "missing", "wrong_type"} {
		t.Run(variant, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			replies := make(chan json.RawMessage, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer ws.CloseNow()
				_, raw, err := ws.Read(ctx)
				if err == nil {
					replies <- raw
				}
			}))
			defer server.Close()
			ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			id := mustID(t)
			body := nodeCompatibilityBody(t, protocol.FileRequest{Type: protocol.BodyFileBrowse, OperationID: id}, variant, "operation_id")
			raw, err := json.Marshal(map[string]any{"envelope": protocol.Envelope{MessageID: mustID(t), Source: &protocol.Source{Kind: protocol.SourceControl}, Body: body}})
			if err != nil {
				t.Fatal(err)
			}
			handleFileEnvelope(ctx, raw, newWSWriter(ws), t.TempDir(), slog.New(slog.DiscardHandler))
			select {
			case raw := <-replies:
				var frame struct {
					Envelope struct {
						Body protocol.FileResult `json:"body"`
					} `json:"envelope"`
				}
				if err := json.Unmarshal(raw, &frame); err != nil {
					t.Fatal(err)
				}
				if frame.Envelope.Body.OK != (variant == "extra") {
					t.Fatalf("命令结果: %s", raw)
				}
				if variant == "extra" && frame.Envelope.Body.OperationID != id {
					t.Fatal("关联字段丢失")
				}
			case <-ctx.Done():
				t.Fatal("没有命令回复")
			}
		})
	}
}

func TestProjectRuntimeIPCCompatibility(t *testing.T) {
	for _, variant := range []string{"extra", "missing", "wrong_type"} {
		t.Run(variant, func(t *testing.T) {
			m := &projectRuntimeManager{clock: monotime.NewManual(time.Time{}), leaseDeadline: time.Minute}
			p := &projectRuntimeProcess{ctx: t.Context(), token: "test-token", done: make(chan struct{}), wake: make(chan struct{}, 1), stop: func() {}}
			p.wake <- struct{}{}
			local := map[string]any{"token": p.token, "request": map[string]any{"operation": "poll_wake", "payload": map[string]any{"wait_ms": 1}, "future": true}, "future": true}
			if variant == "missing" {
				delete(local, "request")
			} else if variant == "wrong_type" {
				local["request"] = 42
			}
			client, server := net.Pipe()
			defer client.Close()
			go m.serveConn(server, p)
			if err := json.NewEncoder(client).Encode(local); err != nil {
				t.Fatal(err)
			}
			var result protocol.ProjectRuntimeResult
			if err := json.NewDecoder(client).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if result.OK != (variant == "extra") {
				t.Fatalf("IPC 结果: %+v", result)
			}
			if result.OK && string(result.Data) != `{"wake":true}` {
				t.Fatal("唤醒字段改变")
			}
		})
	}
}

func TestProjectCommandCompatibility(t *testing.T) {
	for _, variant := range []string{"extra", "missing", "wrong_type"} {
		t.Run(variant, func(t *testing.T) {
			command := projectCommand()
			command.Type = protocol.BodyProjectRunWake
			p := &projectRuntimeProcess{command: command, ctx: t.Context(), wake: make(chan struct{}, 1)}
			m := &projectRuntimeManager{runs: map[string]*projectRuntimeProcess{command.RunID: p}}
			m.handle(protocol.Envelope{Body: nodeCompatibilityBody(t, command, variant, "run_id")})
			m.wg.Wait()
			accepted := false
			select {
			case <-p.wake:
				accepted = true
			default:
			}
			if accepted != (variant == "extra") {
				t.Fatalf("命令处理结果: %v", accepted)
			}
		})
	}
}

func TestRuntimeReportAckCompatibility(t *testing.T) {
	for _, variant := range []string{"extra", "missing", "wrong_type"} {
		t.Run(variant, func(t *testing.T) {
			sender := &runtimeReportSender{messageID: "known"}
			connection := sender.connect()
			connection.sent = true
			body := nodeCompatibilityBody(t, protocol.RuntimeReportResult{Type: protocol.BodyRuntimeReportResult, OK: true, ReportVersion: 42}, variant, "type")
			connection.note(protocol.Envelope{CorrelationID: "known", Body: body})
			if sender.acked != (variant == "extra") {
				t.Fatalf("报告确认结果: %v", sender.acked)
			}
		})
	}
}

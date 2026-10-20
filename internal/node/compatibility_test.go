package node

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/startpermit"
	"github.com/coder/websocket"
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
func compatibilityLoop(t *testing.T, responses ...json.RawMessage) *startLoop {
	t.Helper()
	ctx := t.Context()
	loop := newStartLoop(ctx, Identity{}, nil, &session.Host{DataDir: t.TempDir()}, nil, nil)
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
	for _, name := range []string{"start_permit", "input", "report_ack", "agent", "agent_second_reply", "project_runtime", "control", "children"} {
		for _, variant := range []string{"extra", "missing", "wrong_type"} {
			t.Run(name+"/"+variant, func(t *testing.T) {
				var value any
				switch name {
				case "start_permit":
					value = protocol.StartPermitResult{Type: protocol.BodyStartPermitResult, OK: true, Permit: "known"}
				case "input":
					value = protocol.InputResult{Type: protocol.BodyExecutionInputResult, OK: true, Description: "已知任务说明", Generation: 1}
				case "report_ack":
					value = protocol.ReportAck{Type: protocol.BodyExecutionReportResult, OK: true, EventID: "known"}
				case "agent", "agent_second_reply":
					value = protocol.AgentResult{Type: protocol.BodyAgentResult, OK: true, Data: json.RawMessage(`{"ready":true,"known":42}`)}
				case "project_runtime":
					value = protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: json.RawMessage(`{"known":42}`)}
				case "control":
					value = protocol.ExecutionControl{Type: protocol.BodyExecutionControlResult, OK: true, ExecutionTimeoutSeconds: 42}
				case "children":
					value = protocol.ChildDeliveriesResult{Type: protocol.BodyChildDeliveriesResult, OK: true}
				}
				raw := nodeCompatibilityBody(t, value, variant, "type")
				responses := []json.RawMessage{raw}
				if name == "agent_second_reply" {
					responses = []json.RawMessage{nodeCompatibilityBody(t, value, "extra", "type"), raw}
				}
				loop := compatibilityLoop(t, responses...)
				success := false
				switch name {
				case "start_permit":
					success = loop.onResult(protocol.Envelope{Body: raw})
				case "input":
					got, err := loop.fetchInput(t.Context(), &startJob{})
					success = err == nil
					if success && !strings.Contains(got, "已知任务说明") {
						t.Fatal("说明字段改变")
					}
				case "report_ack":
					success = loop.pushReport(t.Context(), json.RawMessage(`{}`)) == nil
				case "agent", "agent_second_reply":
					req := protocol.AgentRequest{Operation: "get"}
					if name == "agent_second_reply" {
						req.Operation = "result"
						req.TaskID = "child"
						req.SourceTaskID = "parent"
						req.SourceSessionID = mustID(t)
					}
					got := (&agentBridge{loop: loop}).call(t.Context(), req)
					success = got.OK
					if success {
						var data struct {
							Ready bool
							Known int
						}
						if json.Unmarshal(got.Data, &data) != nil || !data.Ready || data.Known != 42 {
							t.Fatal("Agent 回复内容改变")
						}
					}
				case "project_runtime":
					got := (&projectRuntimeManager{loop: loop}).call(t.Context(), protocol.ProjectRuntimeRequest{Operation: "bootstrap"})
					success = got.OK
					if success && string(got.Data) != `{"known":42}` {
						t.Fatal("Runtime 回复内容改变")
					}
				case "control":
					success = loop.checkControl(t.Context(), &startJob{})
				case "children":
					_, err := loop.childRoundTrip(t.Context(), protocol.ChildDeliveryRequest{})
					success = err == nil
				}
				if success != (variant == "extra") {
					t.Fatalf("接收结果: %v", success)
				}
			})
		}
	}
}

func TestNodeCommandCompatibility(t *testing.T) {
	for _, name := range []string{"prepare", "file"} {
		for _, variant := range []string{"extra", "missing", "wrong_type"} {
			t.Run(name+"/"+variant, func(t *testing.T) {
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
				writer := newWSWriter(ws)
				log := slog.New(slog.DiscardHandler)
				ledger := openTestLedger(t)
				var value any
				var required string
				if name == "prepare" {
					in := samplePrepare(t)
					prepared := ledger.Prepare(in, nil)
					dir, err := session.SessionDir(ledger.dir, prepared.SessionID)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.MkdirAll(dir, 0700); err != nil {
						t.Fatal(err)
					}
					value = protocol.PrepareCommand{Type: protocol.BodyPrepare, TaskID: in.TaskID, ExecutionID: in.ExecutionID, TaskVersion: in.TaskVersion, QueueExpiresAt: in.QueueExpiresAt.Format(time.RFC3339Nano), AgentType: in.AgentType}
					required = "queue_expires_at"
				} else {
					value = protocol.FileRequest{Type: protocol.BodyFileBrowse, OperationID: mustID(t)}
					required = "operation_id"
				}
				body := nodeCompatibilityBody(t, value, variant, required)
				raw, err := json.Marshal(map[string]any{"envelope": protocol.Envelope{MessageID: mustID(t), Source: &protocol.Source{Kind: protocol.SourceControl}, Body: body}})
				if err != nil {
					t.Fatal(err)
				}
				if name == "prepare" {
					handleNodeEnvelope(ctx, raw, writer, ledger, nil, []string{"pi", "start"}, log, nil)
				} else {
					handleFileEnvelope(ctx, raw, writer, ledger.dir, log)
				}
				select {
				case raw := <-replies:
					var frame struct {
						Envelope struct {
							Body struct {
								OK          bool   `json:"ok"`
								OperationID string `json:"operation_id"`
								TaskID      string `json:"task_id"`
							} `json:"body"`
						} `json:"envelope"`
					}
					if err := json.Unmarshal(raw, &frame); err != nil {
						t.Fatal(err)
					}
					if frame.Envelope.Body.OK != (variant == "extra") {
						t.Fatalf("命令结果: %s", raw)
					}
					if variant == "extra" && frame.Envelope.Body.OperationID == "" && frame.Envelope.Body.TaskID == "" {
						t.Fatal("关联字段丢失")
					}
				case <-ctx.Done():
					t.Fatal("没有命令回复")
				}
			})
		}
	}
}

func TestProjectRuntimeIPCCompatibility(t *testing.T) {
	for _, variant := range []string{"extra", "missing", "wrong_type"} {
		t.Run(variant, func(t *testing.T) {
			m := &projectRuntimeManager{clock: startpermit.NewManual(time.Time{}), leaseDeadline: time.Minute}
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

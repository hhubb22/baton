package control

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func compatibilityID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func compatibilityBody(t *testing.T, value any, variant string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	switch variant {
	case "extra":
		body["future_field"] = map[string]any{"enabled": true}
	case "missing":
		delete(body, "type")
	case "wrong_type":
		body["type"] = 42
	}
	raw, err = json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestCoordinatorRequestCompatibility(t *testing.T) {
	for _, name := range []string{"sync", "start_permit", "start_report", "input", "report", "control", "agent", "children", "child_ack", "runtime_report"} {
		t.Run(name, func(t *testing.T) {
			for _, variant := range []string{"extra", "missing", "wrong_type"} {
				t.Run(variant, func(t *testing.T) {
					pool := dbtest.Open(t)
					repo := store.New(pool)
					ctx := t.Context()
					employee, err := admin.CreateLocal(ctx, pool, "compatibility", "兼容测试", "compatibility-test-password")
					if err != nil {
						t.Fatal(err)
					}
					signer, err := node.GenerateSigner()
					if err != nil {
						t.Fatal(err)
					}
					_, token, _, err := repo.IssueEnrollment(ctx, employee.ID, time.Hour)
					if err != nil {
						t.Fatal(err)
					}
					registered, err := repo.Register(ctx, store.RegisterInput{Token: token, DisplayName: "兼容设备", System: node.SystemLinux, Role: node.RolePC, Capabilities: []string{"pi", "start"}, CredentialTTL: time.Hour}, signer)
					if err != nil {
						t.Fatal(err)
					}
					src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: employee.ID, NodeID: registered.NodeID, CredentialID: registered.Credential.ID, ConnID: compatibilityID(t), Incarnation: compatibilityID(t)}
					if err := repo.ConnectNode(ctx, src); err != nil {
						t.Fatal(err)
					}
					if err := repo.SyncNode(ctx, src.EmployeeID, src.NodeID, src.ConnID, "兼容设备", node.SystemLinux, "", []string{"pi", "start"}); err != nil {
						t.Fatal(err)
					}
					agent := "pi"
					accepted, err := repo.AcceptTask(ctx, employee.ID, task.Input{RequestID: "compatibility", Description: "验证已知字段", TargetNodeID: &src.NodeID, AgentType: &agent})
					if err != nil {
						t.Fatal(err)
					}
					intent, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
					if err != nil || !ok {
						t.Fatalf("prepare: %v %v", ok, err)
					}
					sessionID, generation := compatibilityID(t), compatibilityID(t)
					if err := repo.SavePrepared(ctx, store.PreparedFact{MessageID: intent.MessageID, EmployeeID: src.EmployeeID, NodeID: src.NodeID, TaskID: accepted.TaskID, ExecutionID: intent.ExecutionID, SessionID: sessionID, StorageGeneration: generation}); err != nil {
						t.Fatal(err)
					}
					start := store.StartRequest{EmployeeID: src.EmployeeID, NodeID: src.NodeID, CredentialID: src.CredentialID, TaskID: accepted.TaskID, ExecutionID: intent.ExecutionID, SessionID: sessionID, StorageGeneration: generation, Nonce: compatibilityID(t)}
					if name != "start_permit" && name != "sync" {
						if d, err := repo.AuthorizeStart(ctx, start); err != nil || !d.Issue {
							t.Fatalf("authorize: %+v %v", d, err)
						}
					}
					if name == "agent" || name == "children" || name == "child_ack" {
						if ok, code, err := repo.ApplyExecutionReport(ctx, store.ExecutionReport{EmployeeID: src.EmployeeID, NodeID: src.NodeID, EventID: compatibilityID(t), TaskID: start.TaskID, ExecutionID: start.ExecutionID, SessionID: sessionID, Kind: protocol.ReportStarted, Status: task.StatusRunning, InputGeneration: 1}); err != nil || !ok {
							t.Fatalf("started: %s %v", code, err)
						}
					}
					input := protocol.InputRequest{TaskID: start.TaskID, ExecutionID: start.ExecutionID, SessionID: sessionID}
					var body any
					var handle func(context.Context, string, protocol.Envelope)
					sender := &projectSender{}
					s, err := New(repo, signer, nil)
					if err != nil {
						t.Fatal(err)
					}
					s.SetSender(sender)
					switch name {
					case "sync":
						body = map[string]any{"type": "node.sync", "display_name": "兼容设备", "system": node.SystemLinux, "capabilities": []string{"pi", "start"}}
						handle = func(ctx context.Context, c string, e protocol.Envelope) {
							raw, _ := json.Marshal(e)
							s.onEnvelope(ctx, c, raw)
						}
					case "start_permit":
						body = protocol.StartPermitRequest{Type: protocol.BodyStartPermit, TaskID: start.TaskID, ExecutionID: start.ExecutionID, SessionID: sessionID, StorageGeneration: generation, Nonce: start.Nonce}
						handle = s.onStartPermit
					case "start_report":
						body = protocol.StartReport{Type: protocol.BodyStartReport, TaskID: start.TaskID, ExecutionID: start.ExecutionID, Code: "expired"}
						handle = s.onStartReport
					case "input":
						input.Type = protocol.BodyExecutionInput
						body = input
						handle = s.onExecutionInput
					case "control":
						input.Type = protocol.BodyExecutionControl
						body = input
						handle = s.onExecutionControl
					case "report":
						body = protocol.ExecutionReport{Type: protocol.BodyExecutionReport, EventID: compatibilityID(t), TaskID: start.TaskID, ExecutionID: start.ExecutionID, SessionID: sessionID, Kind: protocol.ReportStarted, Status: task.StatusRunning, InputGeneration: 1}
						handle = s.onExecutionReport
					case "agent":
						body = protocol.AgentRequest{Type: protocol.BodyAgentRequest, Operation: "get", SourceTaskID: start.TaskID, SourceExecutionID: start.ExecutionID, SourceSessionID: sessionID, TaskID: start.TaskID}
						handle = s.onAgentRequest
					case "children", "child_ack":
						input.Type = protocol.BodyChildDeliveries
						request := protocol.ChildDeliveryRequest{InputRequest: input}
						if name == "child_ack" {
							source := store.AgentSource{EmployeeID: src.EmployeeID, NodeID: src.NodeID, TaskID: start.TaskID, ExecutionID: start.ExecutionID, SessionID: sessionID}
							child, err := repo.AcceptDelegation(ctx, source, task.Input{RequestID: "child", Description: "子任务", TargetNodeID: &src.NodeID, AgentType: &agent})
							if err != nil {
								t.Fatal(err)
							}
							if _, err = repo.RequestCancel(ctx, src.EmployeeID, child.TaskID); err != nil {
								t.Fatal(err)
							}
							deliveries, err := repo.ChildDeliveries(ctx, source, "")
							if err != nil || len(deliveries) != 1 {
								t.Fatalf("deliveries: %v %v", deliveries, err)
							}
							request.Type = protocol.BodyChildDeliveryAck
							request.Receipt = &protocol.ChildReceipt{DeliveryID: deliveries[0].DeliveryID, Status: "delivered", Generation: 2}
						}
						body = request
						handle = s.onChildDelivery
					case "runtime_report":
						body = protocol.RuntimeReportRequest{Type: protocol.BodyRuntimeReport, Report: protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}}}
						handle = s.onRuntimeReport
					}
					handle(ctx, src.ConnID, protocol.Envelope{MessageID: "request", Source: &src, Body: compatibilityBody(t, body, variant)})
					if len(sender.sent) != 1 {
						t.Fatalf("回复数: %d", len(sender.sent))
					}
					var reply struct {
						OK          bool            `json:"ok"`
						Data        json.RawMessage `json:"data"`
						Description string          `json:"description"`
						Permit      string          `json:"permit"`
					}
					if err := json.Unmarshal(sender.sent[0].env.Body, &reply); err != nil {
						t.Fatal(err)
					}
					if reply.OK != (variant == "extra") {
						t.Fatalf("兼容结果错误: OK=%v", reply.OK)
					}
					if variant == "extra" {
						if name == "input" && reply.Description != "验证已知字段" {
							t.Fatal("任务说明改变")
						}
						if name == "start_permit" && reply.Permit == "" {
							t.Fatal("启动许可丢失")
						}
						if name == "agent" {
							var view task.Record
							if err := json.Unmarshal(reply.Data, &view); err != nil || view.TaskID != start.TaskID {
								t.Fatalf("任务标识改变: %s", reply.Data)
							}
						}
					}
				})
			}
		})
	}
}

func TestCoordinatorReplyCompatibility(t *testing.T) {
	for _, name := range []string{"prepare", "file", "session"} {
		for _, variant := range []string{"extra", "missing", "wrong_type"} {
			t.Run(name+"/"+variant, func(t *testing.T) {
				s := &Server{pending: map[string]chan prepareNotice{}, log: slog.New(slog.DiscardHandler)}
				env := protocol.Envelope{CorrelationID: "request", Source: &protocol.Source{Kind: protocol.SourceNode, NodeID: "node"}}
				accepted := false
				switch name {
				case "prepare":
					ch, cancel := s.armPrepare("request")
					defer cancel()
					want := protocol.PrepareResult{Type: protocol.BodyPrepareResult, OK: true, TaskID: "task", SessionID: "session"}
					env.Body = compatibilityBody(t, want, variant)
					s.notePrepareResult(env)
					select {
					case got := <-ch:
						accepted = got.result == want
					default:
					}
				case "file":
					ch, cancel := s.armFile("request")
					defer cancel()
					want := protocol.FileResult{Type: protocol.BodyFileResult, OK: true, OperationID: "operation", Path: "known"}
					env.Body = compatibilityBody(t, want, variant)
					s.noteFileResult(env)
					select {
					case got := <-ch:
						accepted = !got.bad && got.result.Path == want.Path && got.result.OperationID == want.OperationID
					default:
					}
				case "session":
					ch, cancel := s.armSession("request")
					defer cancel()
					want := protocol.SessionResult{Type: protocol.BodySessionResult, OK: true, OperationID: "operation", SessionID: "session", Text: "known"}
					env.Body = compatibilityBody(t, want, variant)
					s.noteSessionResult(env)
					select {
					case got := <-ch:
						accepted = !got.bad && got.result.Text == want.Text && got.result.SessionID == want.SessionID
					default:
					}
				}
				if accepted != (variant == "extra") {
					t.Fatalf("接收结果: %v", accepted)
				}
			})
		}
	}
}

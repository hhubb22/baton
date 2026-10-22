package control

import (
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"encoding/json"
	"log/slog"
	"testing"
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
	for _, name := range []string{"sync", "runtime_report"} {
		for _, variant := range []string{"extra", "missing", "wrong_type"} {
			t.Run(name+"/"+variant, func(t *testing.T) {
				h := newThreadControl(t)
				src := h.addNode("兼容设备")
				if name == "sync" {
					if err := h.repo.ConnectNode(t.Context(), src); err != nil {
						t.Fatal(err)
					}
				}
				sender := &projectSender{}
				h.server.SetSender(sender)
				var body any
				switch name {
				case "sync":
					body = map[string]any{"type": "node.sync", "display_name": "兼容设备", "system": node.SystemLinux, "role": node.RolePC, "capabilities": []string{"pi"}}
				case "runtime_report":
					body = protocol.RuntimeReportRequest{Type: protocol.BodyRuntimeReport, Report: protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}}}
				}
				env := protocol.Envelope{MessageID: compatibilityID(t), Source: &src, Body: compatibilityBody(t, body, variant)}
				raw, _ := json.Marshal(env)
				h.server.onEnvelope(t.Context(), src.ConnID, raw)
				if len(sender.sent) != 1 {
					t.Fatalf("回复数: %d", len(sender.sent))
				}
				var reply struct{ OK bool }
				if err := json.Unmarshal(sender.sent[0].env.Body, &reply); err != nil {
					t.Fatal(err)
				}
				if reply.OK != (variant == "extra") {
					t.Fatalf("兼容结果错误: OK=%v", reply.OK)
				}
				if name == "sync" && reply.OK {
					if err := h.repo.CheckNodeConnection(t.Context(), src, true, true); err != nil {
						t.Fatalf("同步确认后设备未就绪: %v", err)
					}
				}
			})
		}
	}
}

func TestCoordinatorReplyCompatibility(t *testing.T) {
	for _, name := range []string{"file", "session"} {
		for _, variant := range []string{"extra", "missing", "wrong_type"} {
			t.Run(name+"/"+variant, func(t *testing.T) {
				s := &Server{log: slog.New(slog.DiscardHandler)}
				env := protocol.Envelope{CorrelationID: "request", Source: &protocol.Source{Kind: protocol.SourceNode, NodeID: "node"}}
				accepted := false
				switch name {
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

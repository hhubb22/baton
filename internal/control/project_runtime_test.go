package control

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

type projectSent struct {
	nodeID, connID string
	env            protocol.Envelope
}

type projectSender struct {
	sent   []projectSent
	onSend func(protocol.Envelope) error
}

func (s *projectSender) Send(_ context.Context, nodeID, connID string, env protocol.Envelope) error {
	s.sent = append(s.sent, projectSent{nodeID, connID, env})
	if s.onSend != nil {
		return s.onSend(env)
	}
	return nil
}
func (*projectSender) DisconnectCredential(string) {}

func TestProjectRuntimeRejectsMalformedBodies(t *testing.T) {
	sender := &projectSender{}
	s := &Server{sender: sender, log: slog.New(slog.DiscardHandler)}
	src := protocol.Source{Kind: protocol.SourceNode, NodeID: "node"}
	for _, tc := range []struct {
		body, code string
	}{
		{`{"operation":"bootstrap","extra":true}`, "invalid_request"},
		{`{"type":"project_runtime.request"} {}`, "invalid_request"},
		{`{"type":"project_runtime.result"}`, "invalid_request"},
		{`{"type":42}`, "invalid_request"},
		{`{"type":"project_runtime.request","reason":"` + string([]byte{0xff}) + `"}`, "invalid_request"},
		{strings.Repeat(" ", protocol.MaxProjectRuntimeBytes+1), "too_large"},
	} {
		s.onProjectRuntimeRequest(t.Context(), "connection", protocol.Envelope{MessageID: "request", Source: &src, Body: json.RawMessage(tc.body)})
		if len(sender.sent) == 0 {
			t.Fatal("请求缺少响应")
		}
		sent := sender.sent[len(sender.sent)-1]
		var result protocol.ProjectRuntimeResult
		if err := json.Unmarshal(sent.env.Body, &result); err != nil || result.OK || result.Code != tc.code || sent.connID != "connection" || sent.env.CorrelationID != "request" {
			t.Fatalf("格式拒绝: %+v %v", result, err)
		}
	}
}

func TestProjectRunDeliveryAndAuthenticatedRequests(t *testing.T) {
	pool := dbtest.Open(t)
	repo := store.New(pool)
	ctx := t.Context()
	employee, err := admin.CreateLocal(ctx, pool, "project-control", "项目员工", "project-control-password")
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
	registered, err := repo.Register(ctx, store.RegisterInput{Token: token, DisplayName: "项目设备", System: node.SystemLinux, Role: node.RolePC, CredentialTTL: time.Hour}, signer)
	if err != nil {
		t.Fatal(err)
	}
	newID := func() string {
		id, err := identity.NewUUID()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: employee.ID, NodeID: registered.NodeID, CredentialID: registered.Credential.ID, ConnID: newID(), Incarnation: newID()}
	if err := repo.ConnectNode(ctx, src); err != nil {
		t.Fatal(err)
	}
	if err := repo.SyncNode(ctx, employee.ID, src.NodeID, src.ConnID, "项目设备", node.SystemLinux, "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SaveRuntimeReport(ctx, src, protocol.RuntimeReport{ProjectRuntime: &protocol.ProjectRuntime{Version: "test", Providers: []protocol.RuntimeProvider{{Provider: "openai-codex", Status: "available"}}}, Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{}, Repos: []protocol.RuntimeRepo{}}); err != nil {
		t.Fatal(err)
	}
	p, err := repo.CreateProject(ctx, employee.ID, projectagent.CreateInput{Title: "控制层项目", Provider: "openai-codex", Model: "test-model"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AcceptProjectMessage(ctx, employee.ID, p.ID, projectagent.MessageInput{ClientMessageID: "initial", Content: "开始处理"}); err != nil {
		t.Fatal(err)
	}
	sender := &projectSender{}
	s, err := New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.SetSender(sender)
	s.scheduleProjectRunsPage(ctx, "")
	for range 2 {
		s.deliverProjectRuns(ctx)
		if _, err := pool.Exec(ctx, "UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second'"); err != nil {
			t.Fatal(err)
		}
	}
	if len(sender.sent) != 2 {
		t.Fatalf("启动命令数: %d", len(sender.sent))
	}
	first, second := sender.sent[0], sender.sent[1]
	var command protocol.ProjectRunCommand
	if err := json.Unmarshal(first.env.Body, &command); err != nil || command.Type != protocol.BodyProjectRunStart || command.RunID == "" || command.LeaseEpoch != 1 || first.env.MessageID != command.RunID || second.env.MessageID != command.RunID || first.nodeID != src.NodeID || first.connID != src.ConnID {
		t.Fatalf("启动命令与重发: %+v %v", command, err)
	}
	request := func(source protocol.Source, operation string) protocol.ProjectRuntimeResult {
		t.Helper()
		body, err := json.Marshal(protocol.ProjectRuntimeRequest{Type: protocol.BodyProjectRuntimeRequest, RunID: command.RunID, LeaseEpoch: command.LeaseEpoch, Operation: operation})
		if err != nil {
			t.Fatal(err)
		}
		body = compatibilityBody(t, json.RawMessage(body), "extra")
		if err := s.Handle(ctx, source, protocol.Envelope{Version: protocol.Version, MessageID: newID(), Source: &protocol.Source{EmployeeID: "forged"}, Body: body}); err != nil {
			t.Fatal(err)
		}
		var result protocol.ProjectRuntimeResult
		if err := json.Unmarshal(sender.sent[len(sender.sent)-1].env.Body, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if got := request(src, "started"); !got.OK {
		t.Fatalf("启动回执: %+v", got)
	}
	if got := request(src, "renew"); !got.OK {
		t.Fatalf("续租: %+v", got)
	}
	if got := request(src, "unknown_operation"); got.OK || got.Code != "invalid_request" {
		t.Fatalf("非法操作: %+v", got)
	}
	before := len(sender.sent)
	s.deliverProjectRuns(ctx)
	if _, err := pool.Exec(ctx, "UPDATE project_agent_input_queue SET wake_next_at=clock_timestamp()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	s.deliverProjectRuns(ctx)
	wakeIDs := map[string]bool{}
	for _, sent := range sender.sent[before:] {
		var c protocol.ProjectRunCommand
		if err := json.Unmarshal(sent.env.Body, &c); err != nil || c.Type == protocol.BodyProjectRunStart {
			t.Fatalf("启动回执后仍重发 start: %+v %v", c, err)
		}
		if c.Type == protocol.BodyProjectRunWake {
			if wakeIDs[sent.env.MessageID] || sent.env.MessageID == command.RunID {
				t.Fatal("唤醒通知复用了消息 ID")
			}
			wakeIDs[sent.env.MessageID] = true
		}
	}
	if len(wakeIDs) != 2 {
		t.Fatalf("待领取输入没有重复通知: %d", len(wakeIDs))
	}
	if err := repo.StopProjectRun(ctx, employee.ID, p.ID); err != nil {
		t.Fatal(err)
	}
	if got := request(src, "renew"); got.OK || got.Code != "lease_lost" {
		t.Fatalf("停止后旧请求未被拒绝: %+v", got)
	}
	before = len(sender.sent)
	s.deliverProjectRuns(ctx)
	foundStop := false
	for _, sent := range sender.sent[before:] {
		var c protocol.ProjectRunCommand
		if err := json.Unmarshal(sent.env.Body, &c); err != nil {
			t.Fatal(err)
		}
		if c.Type == protocol.BodyProjectRunStop && c.RunID == command.RunID {
			foundStop = true
			if sent.env.MessageID == command.RunID {
				t.Fatal("停止命令复用了启动消息 ID")
			}
		}
	}
	if !foundStop {
		t.Fatal("未投递停止命令")
	}
	for range 2 {
		if got := request(src, "stopped"); !got.OK {
			t.Fatalf("停止回执未幂等接受: %+v", got)
		}
	}
	before = len(sender.sent)
	s.deliverProjectRuns(ctx)
	for _, sent := range sender.sent[before:] {
		var c protocol.ProjectRunCommand
		if err := json.Unmarshal(sent.env.Body, &c); err != nil {
			t.Fatal(err)
		}
		if c.Type == protocol.BodyProjectRunStop && c.RunID == command.RunID {
			t.Fatal("停止回执后仍重发停止命令")
		}
	}
	t.Run("receipt_before_send_error", func(t *testing.T) {
		s.scheduleProjectRunsPage(ctx, "")
		counts := map[string]int{}
		sender.onSend = func(env protocol.Envelope) error {
			if len(s.background) != 0 {
				t.Fatal("发送时仍占用数据库并发门")
			}
			var c protocol.ProjectRunCommand
			if err := json.Unmarshal(env.Body, &c); err != nil {
				t.Fatal(err)
			}
			counts[c.Type]++
			req := protocol.ProjectRuntimeRequest{RunID: c.RunID, LeaseEpoch: c.LeaseEpoch}
			switch c.Type {
			case protocol.BodyProjectRunStart:
				var persisted bool
				if err := pool.QueryRow(ctx, "SELECT command_attempts>0 AND command_next_at>clock_timestamp() FROM agent_runs WHERE id=$1", c.RunID).Scan(&persisted); err != nil || !persisted {
					t.Fatal("发送前没有保存启动尝试", persisted, err)
				}
				req.Operation = "started"
			case protocol.BodyProjectRunWake:
				req.Operation = "wake_received"
				req.Payload, _ = json.Marshal(map[string]any{"input_ids": c.InputIDs})
			case protocol.BodyProjectRunStop:
				req.Operation = "stopped"
			default:
				t.Fatal("意外的发送类型", c.Type)
			}
			if _, err := repo.ProjectRuntime(ctx, src, req); err != nil {
				t.Fatal("发送返回前的回执失败", err)
			}
			return errors.New("injected late send error")
		}
		defer func() { sender.onSend = nil }()
		s.deliverProjectRuns(ctx)
		s.deliverProjectRuns(ctx)
		if counts[protocol.BodyProjectRunStart] != 1 || counts[protocol.BodyProjectRunWake] != 1 {
			t.Fatal("迟到发送错误重开已确认记录", counts)
		}
		if err := repo.StopProjectRun(ctx, employee.ID, p.ID); err != nil {
			t.Fatal(err)
		}
		s.deliverProjectRuns(ctx)
		if _, err := pool.Exec(ctx, "UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second'"); err != nil {
			t.Fatal(err)
		}
		s.deliverProjectRuns(ctx)
		if counts[protocol.BodyProjectRunStop] != 1 {
			t.Fatal("迟到发送错误重开停止确认", counts)
		}
	})
	old := src
	old.ConnID = newID()
	if err := s.Handle(ctx, old, protocol.Envelope{Body: json.RawMessage(`{"type":"project_runtime.request"}`)}); err == nil {
		t.Fatal("非当前连接请求通过认证")
	}
}

package gateway_test

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/control"
	"baton/internal/dbtest"
	"baton/internal/gateway"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/coder/websocket"
)

func TestProjectRuntimeRequestsPassAuthenticatedGateway(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	employee, err := admin.CreateLocal(ctx, pool, "runtime-owner", "项目员工", "project-gateway-password")
	if err != nil {
		t.Fatal(err)
	}
	ident := registerNode(t, ctx, repo, signer, employee.ID, "项目设备")
	ctrl, err := control.New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	gw := gateway.New(ctrl, ctrl, 30*time.Second, nil)
	t.Cleanup(gw.Close)
	ctrl.SetSender(gw)
	srv := httptest.NewTLSServer(gw)
	t.Cleanup(srv.Close)
	go gw.Run(ctx)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	peer, authenticated := dialPeer(t, strings.TrimPrefix(srv.URL, "https://"), ident.Credential.Token, newID(t), roots)
	if !authenticated.OK {
		t.Fatal("节点认证失败")
	}
	t.Cleanup(func() { peer.ws.CloseNow() })
	sendEnvelope(t, peer.ws, map[string]any{"version": protocol.Version, "message_id": newID(t), "body": map[string]any{"type": "node.sync", "display_name": "项目设备", "system": "linux", "capabilities": []string{}}})
	peer.next(t)
	send := func(env any) {
		t.Helper()
		body, err := protocol.MarshalJSON(env)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := protocol.MarshalJSON(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: body})
		if err != nil {
			t.Fatal(err)
		}
		if err := peer.ws.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		reason, code string
	}{
		{"", "lease_lost"},
		{strings.Repeat("<", 128<<10), "lease_lost"},
		{strings.Repeat("x", protocol.MaxProjectRuntimeBytes), "too_large"},
	} {
		id := newID(t)
		send(map[string]any{"version": protocol.Version, "message_id": id, "priority": protocol.PriorityOutput, "body": protocol.ProjectRuntimeRequest{
			Type: protocol.BodyProjectRuntimeRequest, RunID: newID(t), LeaseEpoch: 1, Operation: "renew", Reason: tc.reason,
		}})
		frame := peer.next(t)
		var env protocol.Envelope
		var result protocol.ProjectRuntimeResult
		if frame.Kind != protocol.KindEnvelope || json.Unmarshal(frame.Envelope, &env) != nil || json.Unmarshal(env.Body, &result) != nil || result.Type != protocol.BodyProjectRuntimeResult || result.OK || result.Code != tc.code || env.CorrelationID != id {
			t.Fatalf("运行请求响应(%s): %+v %+v", tc.code, frame, result)
		}
	}
	send(map[string]any{"version": protocol.Version, "message_id": newID(t), "body": protocol.RuntimeReportRequest{
		Type: protocol.BodyRuntimeReport, Report: protocol.RuntimeReport{ProjectRuntime: &protocol.ProjectRuntime{Version: "test", Providers: []protocol.RuntimeProvider{{Provider: "openai-codex", Status: "available"}}}, Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{}, Repos: []protocol.RuntimeRepo{}},
	}})
	var reportEnv protocol.Envelope
	var reportResult protocol.RuntimeReportResult
	if frame := peer.next(t); json.Unmarshal(frame.Envelope, &reportEnv) != nil || json.Unmarshal(reportEnv.Body, &reportResult) != nil || !reportResult.OK {
		t.Fatal("能力报告未保存")
	}
	p, err := repo.CreateProject(ctx, employee.ID, projectagent.CreateInput{Title: "HTML 容量", Provider: "openai-codex", Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	content := strings.Repeat("<", 64<<10)
	if _, err = repo.AcceptProjectMessage(ctx, employee.ID, p.ID, projectagent.MessageInput{ClientMessageID: "html", Content: content}); err != nil {
		t.Fatal(err)
	}
	if err = repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	commands, err := repo.ProjectRunCommands(ctx)
	if err != nil || len(commands) != 1 {
		t.Fatalf("HTML测试未放置: %v %d", err, len(commands))
	}
	command := commands[0].Command
	id := newID(t)
	send(map[string]any{"version": protocol.Version, "message_id": id, "body": protocol.ProjectRuntimeRequest{
		Type: protocol.BodyProjectRuntimeRequest, RunID: command.RunID, LeaseEpoch: command.LeaseEpoch, Operation: "claim_inputs",
	}})
	frame := peer.next(t)
	var env protocol.Envelope
	var result protocol.ProjectRuntimeResult
	var claim projectagent.Claim
	if json.Unmarshal(frame.Envelope, &env) != nil || json.Unmarshal(env.Body, &result) != nil || !result.OK || json.Unmarshal(result.Data, &claim) != nil || claim.Event == nil {
		t.Fatalf("HTML领取失败: %s", env.Body)
	}
	if len(env.Body) > protocol.MaxProjectRuntimeBytes || strings.Contains(string(env.Body), `\u003c`) {
		t.Fatal("HTML正文在响应里膨胀")
	}
	var payload struct {
		Message struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(claim.Event.Payload, &payload) != nil || len(payload.Message.Content) != 1 || !strings.Contains(payload.Message.Content[0].Text, content) {
		t.Fatal("HTML正文在往返中丢失")
	}

}

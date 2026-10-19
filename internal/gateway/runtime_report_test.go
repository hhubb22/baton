package gateway_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/control"
	"baton/internal/dbtest"
	"baton/internal/gateway"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
)

type runtimeReportAttempt struct {
	source protocol.Source
	env    protocol.Envelope
}

type disconnectFirstRuntimeReport struct {
	gateway.Handler
	attempts chan runtimeReportAttempt
	dropped  atomic.Bool
}

func (h *disconnectFirstRuntimeReport) Handle(ctx context.Context, src protocol.Source, env protocol.Envelope) error {
	var body struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(env.Body, &body)
	if body.Type != protocol.BodyRuntimeReport {
		return h.Handler.Handle(ctx, src, env)
	}
	h.attempts <- runtimeReportAttempt{source: src, env: env}
	if err := h.Handler.Handle(ctx, src, env); err != nil {
		return err
	}
	if !h.dropped.Swap(true) {
		return errors.New("测试中断已写入报告的连接")
	}
	return nil
}

type dropFirstRuntimeAck struct {
	gateway.Sender
	acks    chan protocol.Envelope
	dropped bool
}

func (s *dropFirstRuntimeAck) Send(ctx context.Context, nodeID, connID string, env protocol.Envelope) error {
	var ack protocol.RuntimeReportResult
	if json.Unmarshal(env.Body, &ack) == nil && ack.Type == protocol.BodyRuntimeReportResult {
		s.acks <- env
		if !s.dropped {
			s.dropped = true
			return nil
		}
	}
	return s.Sender.Send(ctx, nodeID, connID, env)
}

func TestRuntimeReportLostAckReconnectsAndRejectsUnknownFields(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "runtime-test-password-01")
	if err != nil {
		t.Fatal(err)
	}
	ident := registerNode(t, ctx, repo, signer, emp.ID, "Desk")
	ctrl, err := control.New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := &disconnectFirstRuntimeReport{Handler: ctrl, attempts: make(chan runtimeReportAttempt, 8)}
	gw := gateway.New(ctrl, handler, 30*time.Second, nil)
	sender := &dropFirstRuntimeAck{Sender: gw, acks: make(chan protocol.Envelope, 8)}
	ctrl.SetSender(sender)
	server := httptest.NewTLSServer(gw)
	defer server.Close()
	defer gw.Close()
	go gw.Run(ctx)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	address := strings.TrimPrefix(server.URL, "https://")
	t.Setenv("PATH", t.TempDir())
	stopped := make(chan error, 1)
	go func() {
		stopped <- node.Maintain(ctx, node.RunOptions{RelayURL: "wss://" + address + "/v1/node", Identity: ident, Heartbeat: 100 * time.Millisecond, RootCAs: roots, DataDir: t.TempDir()})
	}()
	defer func() {
		cancel()
		select {
		case err := <-stopped:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("节点连接未结束")
		}
	}()
	var correlation string
	for i := 0; i < 2; i++ {
		select {
		case env := <-sender.acks:
			var ack protocol.RuntimeReportResult
			if json.Unmarshal(env.Body, &ack) != nil || !ack.OK || ack.ReportVersion != 1 {
				t.Fatalf("报告未幂等写入：%s", env.Body)
			}
			if i == 1 && correlation != env.CorrelationID {
				t.Fatal("丢失回执后更换了消息标识")
			}
			correlation = env.CorrelationID
		case <-time.After(5 * time.Second):
			t.Fatal("丢失回执后没有重发")
		}
	}
	first, retry := <-handler.attempts, <-handler.attempts
	if first.source.ConnID == retry.source.ConnID {
		t.Fatal("重试没有经过真实连接重建")
	}
	if first.env.MessageID != retry.env.MessageID || !bytes.Equal(first.env.Body, retry.env.Body) {
		t.Fatal("未确认的报告在重连时更换了消息标识或内容")
	}
	other := registerNode(t, ctx, repo, signer, emp.ID, "Other")
	peer, result := dialPeer(t, address, other.Credential.Token, newID(t), roots)
	if !result.OK {
		t.Fatal("第二个节点认证失败")
	}
	defer peer.ws.CloseNow()
	sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]any{"type": "node.sync", "display_name": "Other", "system": "linux", "capabilities": []string{"start"}}})
	peer.next(t)
	for _, report := range []any{
		map[string]any{"exec": map[string]any{"enabled": false, "shell": "sh"}, "roots": []any{}, "repos": []any{}, "token": "secret"},
		map[string]any{"exec": map[string]any{"enabled": false, "shell": "sh"}, "roots": []any{}, "repos": []any{map[string]any{"path": "/repo", "origin": "https://user:secret@git.example/repo"}}},
	} {
		sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]any{"type": protocol.BodyRuntimeReport, "report": report}})
		frame := peer.next(t)
		var env protocol.Envelope
		var ack protocol.RuntimeReportResult
		if json.Unmarshal(frame.Envelope, &env) != nil || json.Unmarshal(env.Body, &ack) != nil || ack.OK || ack.Code != protocol.CodeInvalidMessage {
			t.Fatalf("不安全报告未被拒绝：%s", env.Body)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM node_runtime_reports WHERE node_id=$1::uuid`, other.NodeID).Scan(&count); err != nil || count != 0 {
		t.Fatal("拒绝的报告仍写入数据库")
	}
}

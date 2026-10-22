package gateway_test

import (
	"context"
	"crypto/x509"
	"encoding/json"
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
	"github.com/coder/websocket"
)

func TestThreadReportsSurviveExhaustedOutputBudget(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pool := dbtest.Open(t)
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "gateway-test-password")
	if err != nil {
		t.Fatal(err)
	}
	ident := registerNode(t, ctx, repo, signer, emp.ID, "Desk")
	budget := protocol.NewBudget(protocol.MaxOutputCacheBytes)
	ctrl, err := control.New(repo, signer, nil, budget)
	if err != nil {
		t.Fatal(err)
	}
	gw := gateway.New(ctrl, ctrl, time.Minute, nil, budget)
	ctrl.SetSender(gw)
	srv := httptest.NewTLSServer(gw)
	defer srv.Close()
	defer gw.Close()
	go gw.Run(ctx)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	inc := newID(t)
	peer, result := dialPeer(t, strings.TrimPrefix(srv.URL, "https://"), ident.Credential.Token, inc, roots)
	if !result.OK {
		t.Fatal(result)
	}
	defer peer.ws.CloseNow()
	sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]any{"type": "node.sync", "display_name": "Desk", "system": "linux", "capabilities": []string{"pi"}}})
	peer.next(t)
	src := protocol.Source{Kind: protocol.SourceNode, NodeID: ident.NodeID, EmployeeID: emp.ID, CredentialID: ident.Credential.ID, Incarnation: inc}
	if err := pool.QueryRow(ctx, "SELECT conn_id FROM node_presence WHERE node_id=$1", ident.NodeID).Scan(&src.ConnID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SaveRuntimeReport(ctx, src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: []protocol.RuntimeAgent{{AgentType: "pi", Version: "1.3.0", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Stop: true}}}}); err != nil {
		t.Fatal(err)
	}
	mid := newID(t)
	thread, _, err := repo.CreateThread(ctx, emp.ID, store.CreateThreadInput{ClientThreadID: newID(t), NodeID: ident.NodeID, AgentType: "pi", WorkingDirectory: "/src", Message: store.ThreadMessageInput{ClientMessageID: mid, Content: "hello"}})
	if err != nil {
		t.Fatal(err)
	}
	if !budget.Reserve(protocol.MaxOutputCacheBytes) {
		t.Fatal("无法占满输出预算")
	}
	defer budget.Release(protocol.MaxOutputCacheBytes)
	for i, kind := range []string{"thread.opened", "turn.started", "message.sent", "reply", "turn.ended"} {
		r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: thread.ID, EventID: newID(t), WorkerSeq: int64(i + 1), Kind: kind, QueueEmpty: true}
		switch kind {
		case "thread.opened":
			r.StorageGeneration, r.NativeSessionID = "generation", "native"
		case "turn.started", "message.sent":
			r.WorkerTurnSeq, r.ClientMessageID = 1, mid
		case "reply":
			r.WorkerTurnSeq, r.Content = 1, "saved reply"
		case "turn.ended":
			r.WorkerTurnSeq, r.Reason = 1, "completed"
		}
		messageID := newID(t)
		sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": messageID, "priority": "output", "body": r})
		frame := peer.next(t)
		var env protocol.Envelope
		var ack protocol.ThreadReportResult
		if json.Unmarshal(frame.Envelope, &env) != nil || json.Unmarshal(env.Body, &ack) != nil || !ack.OK || ack.EventID != r.EventID || env.CorrelationID != messageID {
			t.Fatalf("输出预算阻断报告 %s: %+v %+v", kind, env, ack)
		}
	}
	view, err := repo.GetThread(ctx, emp.ID, thread.ID)
	if err != nil || view.Status != "idle" || view.LastWorkerSeq != 5 {
		t.Fatal(view, err)
	}
}

func TestOutputFloodLeavesOtherNodeThreadAndStopResponsive(t *testing.T) {
	t.Parallel()
	e := startProjectExecStack(t)
	st := e.stack
	attacker := registerThrough(t, st.client, st.base, st.csrf, "Flood")
	peer, result := dialPeer(t, st.nodeAddr, attacker.Credential.Token, newID(t), st.roots)
	if !result.OK {
		t.Fatal(result)
	}
	defer peer.ws.CloseNow()
	sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]any{"type": "node.sync", "display_name": "Flood", "system": "linux", "capabilities": []string{"pi"}}})
	peer.next(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sent, limited atomic.Int64
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			select {
			case <-ctx.Done():
				return
			case frame, ok := <-peer.frames:
				if !ok {
					return
				}
				if frame.Code == protocol.CodeQueueFull {
					limited.Add(1)
				}
			}
		}
	}()
	messageID := newID(t)
	raw, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: mustJSON(t, map[string]any{"version": 1, "message_id": messageID, "priority": "control", "body": protocol.SessionResult{Type: protocol.BodySessionResult, Text: strings.Repeat("x", 16*1024)}})})
	if err != nil {
		t.Fatal(err)
	}
	written := make(chan struct{})
	go func() {
		defer close(written)
		for ctx.Err() == nil {
			if peer.ws.Write(ctx, websocket.MessageText, raw) != nil {
				return
			}
			sent.Add(1)
		}
	}()
	start := time.Now()
	threadID, _ := e.start(t, "flood-other-node", execGatedCommand(), 0)
	e.waitCommandStarted(t)
	waitThreadStatus(t, st, threadID, "running")
	var reply any
	if code := postJSON(t, st.client, st.base+"/api/v1/threads/"+threadID+"/stop", map[string]any{}, st.csrf, &reply); code != 202 {
		t.Fatal(code)
	}
	waitThreadStatus(t, st, threadID, "stopped")
	if time.Since(start) > 8*time.Second {
		t.Fatal("另一节点 Thread 消息与停止被输出阻塞")
	}
	deadline := time.Now().Add(2 * time.Second)
	for limited.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if sent.Load() < 100 || limited.Load() == 0 {
		t.Fatalf("未形成超额输出: sent=%d limited=%d", sent.Load(), limited.Load())
	}
	t.Logf("洪泛消息=%d，限流回执=%d，另一节点消息与停止耗时=%s", sent.Load(), limited.Load(), time.Since(start))
	cancel()
	peer.ws.CloseNow()
	<-written
	<-stopped
	e.assertOneExecution(t, threadID)
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type pausedAuth struct {
	inner            gateway.Authenticator
	entered, release chan struct{}
	once             atomic.Bool
}

func (p *pausedAuth) Authenticate(ctx context.Context, token string) (protocol.Source, error) {
	src, err := p.inner.Authenticate(ctx, token)
	if err == nil && p.once.CompareAndSwap(false, true) {
		close(p.entered)
		select {
		case <-p.release:
		case <-ctx.Done():
			return protocol.Source{}, ctx.Err()
		}
	}
	return src, err
}

func TestRevocationBetweenAuthenticationAndRegistration(t *testing.T) {
	t.Parallel()
	pool := dbtest.Open(t)
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	emp, err := admin.CreateLocal(context.Background(), pool, "alice", "Alice", "gateway-test-password")
	if err != nil {
		t.Fatal(err)
	}
	ident := registerNode(t, context.Background(), repo, signer, emp.ID, "Desk")
	ctrl, err := control.New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	auth := &pausedAuth{inner: ctrl, entered: make(chan struct{}), release: make(chan struct{})}
	gw := gateway.New(auth, ctrl, time.Minute, nil)
	ctrl.SetSender(gw)
	srv := httptest.NewTLSServer(gw)
	defer srv.Close()
	defer gw.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go gw.Run(ctx)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	result := make(chan protocol.Frame, 1)
	go func() {
		result <- dialResult(t, strings.TrimPrefix(srv.URL, "https://"), ident.Credential.Token, newID(t), roots)
	}()
	select {
	case <-auth.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("认证未到门闩")
	}
	if _, err := repo.RevokeNode(ctx, emp.ID, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	close(auth.release)
	select {
	case got := <-result:
		if got.OK || got.Code != protocol.CodeInvalidCredential {
			t.Fatalf("吊销竞争仍通过认证: %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("认证未完成")
	}
	view, err := repo.OwnNode(ctx, emp.ID, ident.NodeID)
	if err != nil || view.Executable() || view.Online {
		t.Fatalf("被吊销连接留下可执行状态: %+v %v", view, err)
	}
}

func TestPendingRevocationRecoversWithoutRestart(t *testing.T) {
	t.Parallel()
	st := startThreadStack(t, nil)
	repo := store.New(st.pool)
	if _, err := repo.RevokeNode(context.Background(), st.employeeID, st.ident.NodeID); err != nil {
		t.Fatal(err)
	}
	waitRevocationHTTP(t, st.client, st.base, st.ident.NodeID, "effective")
	st.batond.waitExit(t, 5*time.Second)
	if !strings.Contains(st.batond.out.String(), "需要重新认证") {
		t.Fatal("吊销未拒绝原客户端重连")
	}
}

func TestClientRetriesTemporaryDatabaseAuthenticationFailure(t *testing.T) {
	pg := startPrivatePostgres(t)
	t.Setenv("BATON_TEST_DATABASE_URL", pg.url)
	st := startThreadStack(t, nil)
	st.batond.stop()
	proxy := newProxy(t, st.nodeAddr)
	args := append([]string(nil), st.batondArgs...)
	for i, arg := range args {
		if arg == "--relay" {
			args[i+1] = "wss://" + proxy.addr() + "/v1/node"
		}
	}
	st.batond = startCmd(t, st.batondBin, args, st.batondEnv)
	waitCount(t, st.batond, "event=connected", 1)
	waitLog(t, st.batond, "event=synced")
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	pg.stop(t)
	proxy.drop()
	time.Sleep(1500 * time.Millisecond)
	if strings.Contains(st.batond.out.String(), "需要重新认证") {
		t.Fatal("数据库暂时不可用使客户端永久退出")
	}
	pg.start(t)
	waitCount(t, st.batond, "event=connected", 2)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	if strings.Count(st.batond.out.String(), "event=connected") < 2 {
		t.Fatal("客户端没有恢复连接")
	}
}

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
	"baton/internal/task"
	"github.com/coder/websocket"
)

func TestSessionControlReceiptsSurviveExhaustedOutputBudget(t *testing.T) {
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go gw.Run(ctx)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	peer, result := dialPeer(t, strings.TrimPrefix(srv.URL, "https://"), ident.Credential.Token, newID(t), roots)
	if !result.OK {
		t.Fatal(result)
	}
	defer peer.ws.CloseNow()
	sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]any{"type": "node.sync", "display_name": "Desk", "system": "linux", "capabilities": []string{"start"}}})
	peer.next(t)
	if !budget.Reserve(protocol.MaxOutputCacheBytes) {
		t.Fatal("无法占满输出预算")
	}
	defer budget.Release(protocol.MaxOutputCacheBytes)
	for _, action := range []string{"input", "input_status"} {
		request := protocol.SessionRequest{OperationID: newID(t), SessionID: newID(t), Action: action, Text: "一次输入"}
		done := make(chan error, 1)
		go func() {
			res, err := ctrl.SessionRequest(ctx, emp.ID, ident.NodeID, request)
			if err == nil && !res.OK {
				err = gateway.ErrUnavailable
			}
			done <- err
		}()
		frame := peer.next(t)
		var env protocol.Envelope
		if json.Unmarshal(frame.Envelope, &env) != nil {
			t.Fatal("无法解析 Session 请求")
		}
		var req protocol.SessionRequest
		_ = json.Unmarshal(env.Body, &req)
		if req.OperationID != request.OperationID || req.Action != action {
			t.Fatal("控制请求未送达原节点")
		}
		// 节点自报 output，服务端仍根据已登记的请求关联保留控制回执额度。
		sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "priority": "output", "correlation_id": env.MessageID, "body": protocol.SessionResult{Type: protocol.BodySessionResult, OperationID: req.OperationID, SessionID: req.SessionID, OK: true}})
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("输出洪泛阻断了控制回执")
		}
	}
	if _, err := ctrl.SessionRequest(ctx, emp.ID, ident.NodeID, protocol.SessionRequest{Action: "output"}); err == nil {
		t.Fatal("输出预算耗尽仍接受输出查询")
	}
}

func TestOutputFloodLeavesOtherNodeTaskAndCancelResponsive(t *testing.T) {
	t.Parallel()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_ABORT_SCRIPT": "confirmed"})
	attacker := registerThrough(t, st.client, st.base, st.csrf, "Flood")
	peer, result := dialPeer(t, st.nodeAddr, attacker.Credential.Token, newID(t), st.roots)
	if !result.OK {
		t.Fatal(result)
	}
	defer peer.ws.CloseNow()
	sendEnvelope(t, peer.ws, map[string]any{"version": 1, "message_id": newID(t), "body": map[string]any{"type": "node.sync", "display_name": "Flood", "system": "linux", "capabilities": []string{"start"}}})
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
	created := acceptTask(t, st, "flood-other-node")
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	var reply any
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, &reply); code != 200 {
		t.Fatal(code)
	}
	waitTaskStatus(t, st, created.TaskID, task.StatusCancelled)
	if time.Since(start) > 8*time.Second {
		t.Fatal("另一节点任务与取消被输出阻塞")
	}
	deadline := time.Now().Add(2 * time.Second)
	for limited.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if sent.Load() < 100 || limited.Load() == 0 {
		t.Fatalf("未形成超额输出: sent=%d limited=%d", sent.Load(), limited.Load())
	}
	t.Logf("洪泛消息=%d，限流回执=%d，另一节点派发与取消耗时=%s", sent.Load(), limited.Load(), time.Since(start))
	cancel()
	peer.ws.CloseNow()
	<-written
	<-stopped
	if executorCount(t, st, "input") != 1 {
		t.Fatal("输出洪泛导致任务重复输入")
	}
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
	st := startPrepareStack(t, nil)
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

func TestLegacyClientRetriesTemporaryDatabaseAuthenticationFailure(t *testing.T) {
	pg := startPrivatePostgres(t)
	t.Setenv("BATON_TEST_DATABASE_URL", pg.url)
	st := startPrepareStack(t, nil)
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
		t.Fatal("数据库暂时不可用使旧客户端永久退出")
	}
	pg.start(t)
	waitCount(t, st.batond, "event=connected", 2)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	if strings.Count(st.batond.out.String(), "event=connected") < 2 {
		t.Fatal("旧客户端没有恢复连接")
	}
}

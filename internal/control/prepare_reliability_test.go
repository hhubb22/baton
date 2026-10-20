package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/gateway"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgxpool"
)

type prepareControl struct {
	t      *testing.T
	pool   *pgxpool.Pool
	repo   *store.Store
	server *Server
	signer node.Signer
	owner  string
}

func newPrepareControl(t *testing.T) *prepareControl {
	t.Helper()
	pool := dbtest.Open(t)
	repo := store.New(pool)
	emp, err := admin.CreateLocal(t.Context(), pool, "prepare-control", "Prepare", "prepare-control-password")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &prepareControl{t: t, pool: pool, repo: repo, server: s, signer: signer, owner: emp.ID}
}

func (h *prepareControl) addNode(name string) protocol.Source {
	h.t.Helper()
	ctx := h.t.Context()
	_, token, _, err := h.repo.IssueEnrollment(ctx, h.owner, time.Hour)
	if err != nil {
		h.t.Fatal(err)
	}
	ident, err := h.repo.Register(ctx, store.RegisterInput{Token: token, DisplayName: name,
		System: node.SystemLinux, Role: node.RolePC, Capabilities: []string{"pi", "start"}, CredentialTTL: time.Hour}, h.signer)
	if err != nil {
		h.t.Fatal(err)
	}
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: h.owner, NodeID: ident.NodeID,
		CredentialID: ident.Credential.ID, ConnID: compatibilityID(h.t), Incarnation: compatibilityID(h.t)}
	if err := h.repo.ConnectNode(ctx, src); err != nil {
		h.t.Fatal(err)
	}
	if err := h.repo.SyncNode(ctx, h.owner, src.NodeID, src.ConnID, name, node.SystemLinux, node.RolePC, []string{"pi", "start"}); err != nil {
		h.t.Fatal(err)
	}
	return src
}

func (h *prepareControl) accept(src protocol.Source, request string) store.PrepareIntent {
	h.t.Helper()
	agent := "pi"
	rec, err := h.repo.AcceptTask(h.t.Context(), h.owner, task.Input{RequestID: request, Description: "prepare reliability",
		TargetNodeID: &src.NodeID, AgentType: &agent})
	if err != nil {
		h.t.Fatal(err)
	}
	var id string
	if err := h.pool.QueryRow(h.t.Context(), `SELECT id::text FROM dispatch_outbox WHERE task_id = $1::uuid`, rec.TaskID).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	fact, err := h.repo.PrepareBinding(h.t.Context(), id)
	if err != nil {
		h.t.Fatal(err)
	}
	return store.PrepareIntent{MessageID: id, TaskID: fact.TaskID, ExecutionID: fact.ExecutionID, EmployeeID: h.owner, NodeID: src.NodeID}
}

type prepareSender struct {
	send func(context.Context, string, protocol.Envelope) error
}

func (s prepareSender) Send(ctx context.Context, nodeID, _ string, env protocol.Envelope) error {
	return s.send(ctx, nodeID, env)
}
func (prepareSender) DisconnectCredential(string) {}

func TestPrepareDispatchDoesNotWaitForSlowNode(t *testing.T) {
	h := newPrepareControl(t)
	slow, fast := h.addNode("slow"), h.addNode("fast")
	first := h.accept(slow, "slow-0")
	for i := range 40 {
		h.accept(slow, fmt.Sprintf("slow-%d", i+1))
	}
	wanted := h.accept(fast, "fast")
	var mu sync.Mutex
	seen := map[string]int{}
	fastSent := make(chan struct{}, 1)
	h.server.SetSender(prepareSender{send: func(ctx context.Context, nodeID string, env protocol.Envelope) error {
		var attempts int
		var evidence bool
		if err := h.pool.QueryRow(ctx, `SELECT attempts, may_have_been_sent FROM dispatch_outbox WHERE id = $1::uuid`, env.MessageID).Scan(&attempts, &evidence); err != nil {
			return err
		}
		if attempts != 1 || !evidence {
			t.Errorf("发送前未保存尝试: %d %v", attempts, evidence)
		}
		mu.Lock()
		seen[nodeID]++
		mu.Unlock()
		if nodeID == fast.NodeID {
			if env.MessageID != wanted.MessageID {
				t.Errorf("消息身份改变")
			}
			fastSent <- struct{}{}
			return nil
		}
		if env.MessageID != first.MessageID {
			t.Errorf("慢节点领取顺序改变")
		}
		return gateway.ErrUnavailable
	}})
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); h.server.DeliverPrepares(ctx) }()
	select {
	case <-fastSent:
	case <-time.After(2 * time.Second):
		t.Error("正常节点被慢节点阻塞")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("派发未随取消结束")
	}
	mu.Lock()
	defer mu.Unlock()
	if seen[slow.NodeID] != 1 || seen[fast.NodeID] != 1 {
		t.Fatalf("节点额度: %+v", seen)
	}
	rec, err := h.repo.GetTask(t.Context(), h.owner, first.TaskID)
	if err != nil || rec.Status != task.StatusQueued {
		t.Fatalf("传输错误终结任务: %+v %v", rec, err)
	}
}

func TestPrepareLateReplyWithoutWaiterAndInvalidSource(t *testing.T) {
	h := newPrepareControl(t)
	src := h.addNode("source")
	intent := h.accept(src, "late")
	h.server.deliverPrepareBatch(t.Context()) // 无 Sender，持久尝试保留。
	if _, err := h.pool.Exec(t.Context(), `UPDATE dispatch_outbox SET lease_until = now() - interval '1 second' WHERE id = $1::uuid`, intent.MessageID); err != nil {
		t.Fatal(err)
	}
	ok := protocol.PrepareResult{Type: protocol.BodyPrepareResult, OK: true, TaskID: intent.TaskID,
		ExecutionID: intent.ExecutionID, SessionID: compatibilityID(t), StorageGeneration: compatibilityID(t)}
	deliver := func(ctx context.Context, source protocol.Source, correlation string, result protocol.PrepareResult) {
		t.Helper()
		raw, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		h.server.notePrepareResult(ctx, protocol.Envelope{CorrelationID: correlation, Source: &source, Body: raw})
	}
	assertUnprepared := func() {
		t.Helper()
		var prepared, acked bool
		if err := h.pool.QueryRow(t.Context(), `SELECT e.prepared_at IS NOT NULL, o.acked_at IS NOT NULL FROM executions e JOIN dispatch_outbox o ON o.execution_id = e.id WHERE o.id = $1::uuid`, intent.MessageID).Scan(&prepared, &acked); err != nil {
			t.Fatal(err)
		}
		if prepared || acked {
			t.Fatal("无效或未保存的回包改变了事实")
		}
	}
	wrong := src
	wrong.NodeID = compatibilityID(t)
	deliver(t.Context(), wrong, intent.MessageID, ok)
	wrong = src
	wrong.EmployeeID = compatibilityID(t)
	deliver(t.Context(), wrong, intent.MessageID, ok)
	deliver(t.Context(), src, compatibilityID(t), ok)
	bad := ok
	bad.ExecutionID = compatibilityID(t)
	deliver(t.Context(), src, intent.MessageID, bad)
	bad = protocol.PrepareResult{Type: protocol.BodyPrepareResult, Code: task.CodeInvalidTarget, Message: "bad", TaskID: compatibilityID(t)}
	deliver(t.Context(), src, intent.MessageID, bad)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	deliver(canceled, src, intent.MessageID, ok)
	assertUnprepared()
	for range 2 {
		deliver(t.Context(), src, intent.MessageID, ok)
	}
	deliver(t.Context(), src, intent.MessageID, protocol.PrepareResult{Type: protocol.BodyPrepareResult, Code: task.CodeInvalidTarget, Message: "late rejection"})
	var prepared, acked bool
	var status string
	var sessions, events int
	if err := h.pool.QueryRow(t.Context(), `SELECT e.prepared_at IS NOT NULL, o.acked_at IS NOT NULL, t.status,
		(SELECT count(*) FROM sessions WHERE bound_execution_id = e.id),
		(SELECT count(*) FROM task_events WHERE task_id = t.id AND kind = 'prepared')
		FROM tasks t JOIN executions e ON e.task_id = t.id JOIN dispatch_outbox o ON o.execution_id = e.id
		WHERE o.id = $1::uuid`, intent.MessageID).Scan(&prepared, &acked, &status, &sessions, &events); err != nil {
		t.Fatal(err)
	}
	if !prepared || !acked || status != task.StatusQueued || sessions != 1 || events != 1 {
		t.Fatalf("晚到回包: %v %v %s %d %d", prepared, acked, status, sessions, events)
	}
}

func TestPrepareReplyRequiresCurrentAuthenticatedConnection(t *testing.T) {
	h := newPrepareControl(t)
	src := h.addNode("source")
	intent := h.accept(src, "authenticated")
	raw, err := json.Marshal(protocol.PrepareResult{Type: protocol.BodyPrepareResult, Code: task.CodeInvalidTarget, Message: "directory missing"})
	if err != nil {
		t.Fatal(err)
	}
	env := protocol.Envelope{Version: protocol.Version, MessageID: compatibilityID(t), CorrelationID: intent.MessageID, Body: raw}
	stale := src
	stale.ConnID = compatibilityID(t)
	if err := h.server.Handle(t.Context(), stale, env); err == nil {
		t.Fatal("过期连接写入准备结果")
	}
	rec, err := h.repo.GetTask(t.Context(), h.owner, intent.TaskID)
	if err != nil || rec.Status != task.StatusQueued {
		t.Fatalf("错误连接改变任务: %+v %v", rec, err)
	}
	if err := h.server.Handle(t.Context(), src, env); err != nil {
		t.Fatal(err)
	}
	rec, err = h.repo.GetTask(t.Context(), h.owner, intent.TaskID)
	if err != nil || rec.Status != task.StatusFailed || rec.ErrorCode == nil || *rec.ErrorCode != task.CodeInvalidTarget {
		t.Fatalf("合法的最小失败回包未保存: %+v %v", rec, err)
	}
}

func TestPrepareReplyBeforeSendErrorStaysAcknowledged(t *testing.T) {
	h := newPrepareControl(t)
	src := h.addNode("source")
	intent := h.accept(src, "ack-before-error")
	h.server.SetSender(prepareSender{send: func(ctx context.Context, _ string, env protocol.Envelope) error {
		raw, _ := json.Marshal(protocol.PrepareResult{Type: protocol.BodyPrepareResult, OK: true, TaskID: intent.TaskID,
			ExecutionID: intent.ExecutionID, SessionID: compatibilityID(t), StorageGeneration: compatibilityID(t)})
		h.server.notePrepareResult(ctx, protocol.Envelope{Source: &src, CorrelationID: env.MessageID, Body: raw})
		return errors.New("late transport failure")
	}})
	h.server.deliverPrepareBatch(t.Context())
	h.server.deliverPrepareBatch(t.Context())
	var attempts int
	var acked bool
	if err := h.pool.QueryRow(t.Context(), `SELECT attempts, acked_at IS NOT NULL FROM dispatch_outbox WHERE id = $1::uuid`, intent.MessageID).Scan(&attempts, &acked); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !acked {
		t.Fatalf("发送错误重新打开确认: %d %v", attempts, acked)
	}
}

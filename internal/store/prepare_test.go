package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "modernc.org/sqlite"
)

func TestPrepareFactsAndSessionOwnership(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	desk := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "codex", "start"})
	other := mustRegister(t, ctx, pool, repo, alice.ID, "Other", node.RolePC, []string{"pi", "codex", "start"})
	bobNode := mustRegister(t, ctx, pool, repo, bob.ID, "Bob", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, desk.NodeID, "pi")
	setDefaultAgent(t, ctx, pool, other.NodeID, "pi")
	setDefaultAgent(t, ctx, pool, bobNode.NodeID, "pi")

	if _, ok, err := repo.ClaimPrepare(ctx, 5*time.Second); err != nil || ok {
		t.Fatalf("没有任务时被领取: %v %v", err, ok)
	}
	accepted, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "prep-1", Description: "调查天线"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := repo.ClaimPrepare(ctx, 5*time.Second); err != nil || ok {
		t.Fatalf("离线节点被领取: %v %v", err, ok)
	}
	connID := markOnline(t, ctx, repo, alice.ID, desk)
	if _, ok, err := repo.ClaimPrepare(ctx, 5*time.Second); err != nil || ok {
		t.Fatalf("未同步节点被领取: %v %v", err, ok)
	}
	if err := repo.SyncNode(ctx, alice.ID, desk.NodeID, connID, desk.DisplayName, desk.System, desk.Role, desk.Capabilities); err != nil {
		t.Fatal(err)
	}
	intent, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
	if err != nil || !ok || intent.TaskID != accepted.TaskID || intent.MessageID == "" || intent.AgentType != "pi" {
		t.Fatalf("没有领到准备投递: %v %v %+v", err, ok, intent)
	}
	sessionID := mustUUID(t)
	generation := mustUUID(t)
	fact := store.PreparedFact{
		MessageID: intent.MessageID, EmployeeID: alice.ID, NodeID: desk.NodeID,
		TaskID: accepted.TaskID, ExecutionID: intent.ExecutionID,
		SessionID: sessionID, StorageGeneration: generation,
	}
	if err := repo.SavePrepared(ctx, fact); err != nil {
		t.Fatal(err)
	}
	if err := repo.SavePrepared(ctx, fact); err != nil {
		t.Fatal(err)
	}
	var status string
	var version int
	var prepared bool
	var acked bool
	var events int
	var relations int
	if err := pool.QueryRow(ctx, `
		SELECT t.status, t.version, e.prepared_at IS NOT NULL, o.acked_at IS NOT NULL,
		       (SELECT COUNT(*) FROM task_events WHERE task_id = t.id),
		       (SELECT COUNT(*) FROM task_relations WHERE task_id = t.id AND target_session_id = $2::uuid)
		FROM tasks t
		JOIN executions e ON e.task_id = t.id
		JOIN dispatch_outbox o ON o.task_id = t.id
		WHERE t.id = $1::uuid`, accepted.TaskID, sessionID).Scan(&status, &version, &prepared, &acked, &events, &relations); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusQueued || version != 2 || !prepared || !acked || events != 2 || relations != 1 {
		t.Fatalf("准备事实不正确: status %s version %d prepared %v acked %v events %d relations %d", status, version, prepared, acked, events, relations)
	}
	var sessions int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM sessions WHERE id = $1::uuid AND status = 'idle' AND bound_execution_id = $2::uuid AND storage_generation = $3`, sessionID, intent.ExecutionID, generation).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("Session 没有按原执行保存: %v %d", err, sessions)
	}
	view, err := repo.GetSession(ctx, alice.ID, sessionID)
	if err != nil || !view.Busy || len(view.TaskIDs) != 1 || view.TaskIDs[0] != accepted.TaskID {
		t.Fatalf("任务与 Session 的关系不可查询: %v %+v", err, view)
	}
	if _, err := repo.GetSession(ctx, bob.ID, sessionID); err != store.ErrNotVisible {
		t.Fatalf("其他员工看到了 Session: %v", err)
	}
	if _, ok, err := repo.ClaimPrepare(ctx, 5*time.Second); err != nil || ok {
		t.Fatalf("已确认的投递被再次领取: %v %v", err, ok)
	}

	idle := mustUUID(t)
	insertSession(t, ctx, pool, idle, alice.ID, desk.NodeID, "pi", "idle")
	setDefaultAgent(t, ctx, pool, desk.NodeID, "codex")
	adopted, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "adopt", Description: "沿用 Session", TargetSessionID: &idle, TargetNodeID: &desk.NodeID,
	})
	if err != nil || adopted.AgentType != "pi" || adopted.TargetSessionID == nil || *adopted.TargetSessionID != idle {
		t.Fatalf("没有沿用 Session 的 Agent: %v %+v", err, adopted)
	}
	before := countFor(t, ctx, pool, alice.ID).tasks
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "busy", Description: "忙碌", TargetSessionID: &idle, TargetNodeID: &desk.NodeID, AgentType: strPtr("pi"),
	})
	assertCode(t, err, task.CodeSessionBusy, "target_session_id")
	fresh := mustUUID(t)
	insertSession(t, ctx, pool, fresh, alice.ID, desk.NodeID, "pi", "idle")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "mismatch", Description: "不匹配", TargetSessionID: &fresh, TargetNodeID: &desk.NodeID, AgentType: strPtr("codex"),
	})
	assertCode(t, err, task.CodeUnsupported, "")
	stopped := mustUUID(t)
	insertSession(t, ctx, pool, stopped, alice.ID, desk.NodeID, "pi", "stopped")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "stopped", Description: "已停止", TargetSessionID: &stopped, TargetNodeID: &desk.NodeID,
	})
	assertCode(t, err, task.CodeInvalidTarget, "target_session_id")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "wrong-node", Description: "节点不符", TargetSessionID: &fresh, TargetNodeID: &other.NodeID,
	})
	assertCode(t, err, task.CodeInvalidTarget, "target_session_id")
	foreign := mustUUID(t)
	insertSession(t, ctx, pool, foreign, bob.ID, bobNode.NodeID, "pi", "idle")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "foreign-target", Description: "他人 Session", TargetSessionID: &foreign, TargetNodeID: &desk.NodeID, AgentType: strPtr("pi"),
	})
	assertCode(t, err, task.CodeForbidden, "")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "foreign-source", Description: "他人来源", SourceSessionID: &foreign, TargetNodeID: &desk.NodeID, AgentType: strPtr("pi"),
	})
	assertCode(t, err, task.CodeForbidden, "")
	if countFor(t, ctx, pool, alice.ID).tasks != before {
		t.Fatal("被拒绝的 Session 请求写入了任务")
	}
	if _, err := pool.Exec(ctx, `UPDATE dispatch_outbox SET acked_at = now() WHERE acked_at IS NULL`); err != nil {
		t.Fatal(err)
	}

	failed, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "reject-me", Description: "会被拒绝", TargetNodeID: &desk.NodeID, AgentType: strPtr("pi"),
	})
	if err != nil {
		t.Fatal(err)
	}
	rejected, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
	if err != nil || !ok || rejected.TaskID != failed.TaskID {
		t.Fatalf("没有领到待拒绝投递: %v %v %+v", err, ok, rejected)
	}
	if err := repo.FailPrepare(ctx, store.PreparedFact{MessageID: rejected.MessageID}, task.CodeSessionBusy, "Session 正在执行其他任务"); err != nil {
		t.Fatal(err)
	}
	rec, err := repo.GetTask(ctx, alice.ID, failed.TaskID)
	if err != nil || rec.Status != task.StatusFailed || rec.ErrorCode == nil || *rec.ErrorCode != task.CodeSessionBusy {
		t.Fatalf("明确拒绝没有失败任务: %v %+v", err, rec)
	}

	expired, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "expire-me", Description: "尚未投递", TargetNodeID: &desk.NodeID, AgentType: strPtr("pi"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE dispatch_outbox SET send_deadline = now() - interval '1 second' WHERE task_id = $1::uuid AND attempts = 0`, expired.TaskID); err != nil {
		t.Fatal(err)
	}
	if err := repo.FailUnsentPrepares(ctx); err != nil {
		t.Fatal(err)
	}
	rec, err = repo.GetTask(ctx, alice.ID, expired.TaskID)
	if err != nil || rec.Status != task.StatusFailed || rec.ErrorCode == nil || *rec.ErrorCode != task.CodeQueueTimeout {
		t.Fatalf("未投递超时没有失败: %v %+v", err, rec)
	}
}

func TestExpiredDeliveryRetriesUntilNodeAnswers(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	desk := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, desk.NodeID, "pi")
	connID := markOnline(t, ctx, repo, alice.ID, desk)
	if err := repo.SyncNode(ctx, alice.ID, desk.NodeID, connID, desk.DisplayName, desk.System, desk.Role, desk.Capabilities); err != nil {
		t.Fatal(err)
	}

	kept := acceptQueued(t, ctx, pool, repo, alice.ID, desk.NodeID, "lost-ack")
	ledgerDir := t.TempDir()
	ledger, err := node.OpenLedger(ledgerDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ledger.Close() })
	first := ledger.Prepare(nodePrepare(kept, 1, time.Now().Add(time.Minute)), nil)
	if !first.OK || first.ExecutionID != kept.ExecutionID || receiptCount(t, ledgerDir) != 1 {
		t.Fatalf("节点没有先准备好: %+v", first)
	}
	markHandedOff(t, ctx, pool, kept.TaskID)
	intent := claimExpired(t, ctx, repo, kept)
	again := ledger.Prepare(nodePrepare(kept, intent.TaskVersion, intent.QueueExpiresAt), nil)
	if !again.OK || again.ExecutionID != kept.ExecutionID || again.SessionID != first.SessionID || receiptCount(t, ledgerDir) != 1 {
		t.Fatalf("过期重发没有返回原映射: %+v", again)
	}
	if err := repo.SavePrepared(ctx, store.PreparedFact{
		MessageID: intent.MessageID, EmployeeID: alice.ID, NodeID: desk.NodeID,
		TaskID: kept.TaskID, ExecutionID: kept.ExecutionID,
		SessionID: again.SessionID, StorageGeneration: again.StorageGeneration,
	}); err != nil {
		t.Fatal(err)
	}
	assertPreparedOnce(t, ctx, pool, kept.TaskID, again.SessionID)

	missed := acceptQueued(t, ctx, pool, repo, alice.ID, desk.NodeID, "never-arrived")
	markHandedOff(t, ctx, pool, missed.TaskID)
	emptyDir := t.TempDir()
	empty, err := node.OpenLedger(emptyDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { empty.Close() })
	retry := claimExpired(t, ctx, repo, missed)
	late := empty.Prepare(nodePrepare(missed, retry.TaskVersion, retry.QueueExpiresAt), nil)
	if late.OK || late.Silent || late.Code != task.CodeQueueTimeout || receiptCount(t, emptyDir) != 0 {
		t.Fatalf("未收到的过期重发结果不正确: %+v", late)
	}
	if err := repo.FailPrepare(ctx, store.PreparedFact{MessageID: retry.MessageID}, late.Code, late.Message); err != nil {
		t.Fatal(err)
	}
	rec, err := repo.GetTask(ctx, alice.ID, missed.TaskID)
	if err != nil || rec.Status != task.StatusFailed || rec.ErrorCode == nil || *rec.ErrorCode != task.CodeQueueTimeout {
		t.Fatalf("中心没有记为超时: %v %+v", err, rec)
	}
	var executions int
	var prepared bool
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*), bool_or(prepared_at IS NOT NULL)
		FROM executions WHERE task_id = $1::uuid`, missed.TaskID).Scan(&executions, &prepared); err != nil || executions != 1 || prepared {
		t.Fatalf("超时任务的执行不正确: %v %d prepared %v", err, executions, prepared)
	}

	unsent, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "still-local", Description: "尚未交出", TargetNodeID: &desk.NodeID, AgentType: strPtr("pi"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE tasks
		SET created_at = now() - interval '2 minutes',
		    queue_expires_at = now() - interval '1 second'
		WHERE id = $1::uuid`, unsent.TaskID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE dispatch_outbox
		SET send_deadline = now() - interval '1 second'
		WHERE task_id = $1::uuid AND attempts = 0`, unsent.TaskID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := repo.ClaimPrepare(ctx, 5*time.Second); err != nil || ok {
		t.Fatalf("从未交出的过期消息被重发: %v %v", err, ok)
	}
	if err := repo.FailUnsentPrepares(ctx); err != nil {
		t.Fatal(err)
	}
	rec, err = repo.GetTask(ctx, alice.ID, unsent.TaskID)
	if err != nil || rec.Status != task.StatusFailed || rec.ErrorCode == nil || *rec.ErrorCode != task.CodeQueueTimeout {
		t.Fatalf("未投递超时没有失败: %v %+v", err, rec)
	}
}

type handedPrepare struct {
	TaskID      string
	ExecutionID string
	MessageID   string
}

func acceptQueued(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repo *store.Store, employeeID, nodeID, requestID string) handedPrepare {
	t.Helper()
	rec, err := repo.AcceptTask(ctx, employeeID, task.Input{
		RequestID: requestID, Description: "过期后仍要确定结果", TargetNodeID: &nodeID, AgentType: strPtr("pi"),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := handedPrepare{TaskID: rec.TaskID, ExecutionID: executionID(t, ctx, pool, rec.TaskID)}
	if err := pool.QueryRow(ctx, `SELECT id::text FROM dispatch_outbox WHERE task_id = $1::uuid`, rec.TaskID).Scan(&got.MessageID); err != nil {
		t.Fatal(err)
	}
	return got
}

func markHandedOff(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		UPDATE tasks
		SET created_at = now() - interval '2 minutes',
		    queue_expires_at = now() - interval '1 second'
		WHERE id = $1::uuid`, taskID); err != nil {
		t.Fatal(err)
	}
	tag, err := pool.Exec(ctx, `
		UPDATE dispatch_outbox
		SET attempts = 1, send_deadline = now() - interval '1 second', lease_until = NULL
		WHERE task_id = $1::uuid AND acked_at IS NULL`, taskID)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("标记已交给 Relay 失败: %v", err)
	}
}

func claimExpired(t *testing.T, ctx context.Context, repo *store.Store, want handedPrepare) store.PrepareIntent {
	t.Helper()
	intent, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
	if err != nil || !ok || intent.MessageID != want.MessageID || intent.TaskID != want.TaskID || intent.ExecutionID != want.ExecutionID {
		t.Fatalf("过期后没有重发原消息: %v %v %+v", err, ok, intent)
	}
	if !intent.QueueExpiresAt.Before(time.Now()) {
		t.Fatal("重发的排队期限仍未到期")
	}
	return intent
}

func nodePrepare(got handedPrepare, version int, expires time.Time) node.PrepareInput {
	return node.PrepareInput{
		MessageID: got.MessageID, TaskID: got.TaskID, ExecutionID: got.ExecutionID,
		TaskVersion: version, QueueExpiresAt: expires, AgentType: "pi",
		Capabilities: []string{"pi", "start"},
	}
}

func assertPreparedOnce(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID, sessionID string) {
	t.Helper()
	var status string
	var executions, sessions int
	var prepared bool
	if err := pool.QueryRow(ctx, `
		SELECT t.status,
		       (SELECT COUNT(*) FROM executions WHERE task_id = t.id),
		       bool_or(e.prepared_at IS NOT NULL),
		       (SELECT COUNT(*) FROM sessions WHERE id = $2::uuid AND bound_execution_id = e.id)
		FROM tasks t
		JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid
		GROUP BY t.id, t.status, e.id`, taskID, sessionID).Scan(&status, &executions, &prepared, &sessions); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusQueued || executions != 1 || !prepared || sessions != 1 {
		t.Fatalf("已准备的重发结果不正确: status %s executions %d prepared %v sessions %d", status, executions, prepared, sessions)
	}
}

func receiptCount(t *testing.T, dir string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "node.db"))+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM receipts`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func markOnline(t *testing.T, ctx context.Context, repo *store.Store, employeeID string, ident node.Identity) string {
	t.Helper()
	connID := mustUUID(t)
	if err := repo.UpsertPresence(ctx, protocol.Presence{
		NodeID: ident.NodeID, EmployeeID: employeeID, CredentialID: ident.Credential.ID,
		Incarnation: mustUUID(t), ConnID: connID, Online: true, LastContact: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	return connID
}

func insertSession(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, employeeID, nodeID, agent, status string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (
			id, employee_id, node_id, agent_type, status, created_at, updated_at
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now(), now())`,
		id, employeeID, nodeID, agent, status); err != nil {
		t.Fatal(err)
	}
}

func mustUUID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

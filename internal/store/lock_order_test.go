package store_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/store"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPrepareTransactionsLockTaskBeforeExecution(t *testing.T) {
	for _, tc := range []struct {
		name        string
		failPrepare bool
		cancel      bool
	}{
		{name: "save/start"},
		{name: "save/cancel", cancel: true},
		{name: "fail/start", failPrepare: true},
		{name: "fail/cancel", failPrepare: true, cancel: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
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
			for round := 0; round < 10; round++ {
				t.Run(fmt.Sprint(round), func(t *testing.T) {
					accepted, err := repo.AcceptTask(ctx, alice.ID, task.Input{
						RequestID: "lock-order-" + mustUUID(t), Description: "核对准备和启动的加锁顺序",
					})
					if err != nil {
						t.Fatal(err)
					}
					intent, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
					if err != nil || !ok || intent.TaskID != accepted.TaskID {
						t.Fatalf("没有领到准备投递: %v %v %+v", err, ok, intent)
					}
					fact := store.PreparedFact{
						MessageID: intent.MessageID, EmployeeID: alice.ID, NodeID: desk.NodeID,
						TaskID: intent.TaskID, ExecutionID: intent.ExecutionID,
						SessionID: mustUUID(t), StorageGeneration: mustUUID(t),
					}
					in := store.StartRequest{
						EmployeeID: alice.ID, NodeID: desk.NodeID, CredentialID: desk.Credential.ID,
						TaskID: fact.TaskID, ExecutionID: fact.ExecutionID, SessionID: fact.SessionID,
						StorageGeneration: fact.StorageGeneration, Nonce: mustUUID(t),
					}
					release, gatePID := holdExecution(t, ctx, pool, fact.ExecutionID)
					prepared := make(chan error, 1)
					go func() {
						if tc.failPrepare {
							prepared <- repo.FailPrepare(ctx, store.PreparedFact{MessageID: fact.MessageID}, task.CodeUnsupported, "节点拒绝准备")
						} else {
							prepared <- repo.SavePrepared(ctx, fact)
						}
					}()
					preparePID := waitForBlockedBy(t, ctx, pool, gatePID)
					competed := make(chan error, 1)
					go func() {
						if tc.cancel {
							_, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
							competed <- err
						} else {
							decision, err := repo.AuthorizeStart(ctx, in)
							if err == nil && decision.Issue == tc.failPrepare {
								err = fmt.Errorf("启动许可不符合准备结果: %+v", decision)
							}
							competed <- err
						}
					}()
					// 修复前，许可/取消持有 tasks 并排在准备事务之后等待 executions；
					// 放开闸门便形成死锁。修复后它只能等待准备事务持有的 tasks。
					waitForBlockedBy(t, ctx, pool, preparePID)
					release()
					if err := <-prepared; err != nil {
						t.Fatalf("准备落库失败: %v", err)
					}
					if err := <-competed; err != nil {
						t.Fatalf("启动/取消失败: %v", err)
					}
					want := task.StatusFailed
					if !tc.failPrepare {
						want = task.StatusCancelled
						if !tc.cancel {
							ack, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t)))
							if err != nil || !ack || code != "" {
								t.Fatalf("启动事实没有保存: %v %v %s", err, ack, code)
							}
							want = task.StatusRunning
						}
					}
					var status string
					var acked, preparedAt bool
					if err := pool.QueryRow(ctx, `SELECT t.status, o.acked_at IS NOT NULL, e.prepared_at IS NOT NULL
						FROM tasks t JOIN executions e ON e.task_id = t.id
						JOIN dispatch_outbox o ON o.execution_id = e.id
						WHERE t.id = $1::uuid`, in.TaskID).Scan(&status, &acked, &preparedAt); err != nil {
						t.Fatal(err)
					}
					if status != want || !acked || preparedAt == tc.failPrepare {
						t.Fatalf("任务未收敛: status %s want %s acked %v prepared %v", status, want, acked, preparedAt)
					}
				})
			}
		})
	}
}

func TestExecutionTransactionsLockTaskBeforeExecution(t *testing.T) {
	for _, name := range []string{"start", "cancel", "report", "refusal", "queue_expiry", "execution_expiry"} {
		t.Run(name, func(t *testing.T) {
			ctx, repo, pool, in, _ := preparedStart(t)
			if decision, err := repo.AuthorizeStart(ctx, in); err != nil || !decision.Issue {
				t.Fatalf("没有授权: %v %+v", err, decision)
			}
			if name == "queue_expiry" {
				if _, err := pool.Exec(ctx, `UPDATE tasks SET created_at = now() - interval '1 hour',
					queue_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, in.TaskID); err != nil {
					t.Fatal(err)
				}
			}
			if name == "execution_expiry" {
				if ack, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ack || code != "" {
					t.Fatalf("启动事实没有保存: %v %v %s", err, ack, code)
				}
			}
			report := startedReport(in, mustUUID(t))
			release, gatePID := holdExecution(t, ctx, pool, in.ExecutionID)
			done := make(chan error, 1)
			go func() {
				var err error
				switch name {
				case "start":
					_, err = repo.AuthorizeStart(ctx, in)
				case "cancel":
					_, err = repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
				case "report":
					var ack bool
					var code string
					ack, code, err = repo.ApplyExecutionReport(ctx, report)
					if err == nil && (!ack || code != "") {
						err = fmt.Errorf("启动事实没有保存: %v %s", ack, code)
					}
				case "refusal":
					err = repo.RecordStartRefusal(ctx, in.EmployeeID, in.NodeID, in.TaskID, in.ExecutionID)
				case "queue_expiry":
					err = repo.ExpireQueuedTasks(ctx)
				case "execution_expiry":
					err = repo.ExpireExecutionsAt(ctx, time.Now().Add(3*time.Hour))
				}
				done <- err
			}()
			waitForBlockedBy(t, ctx, pool, gatePID)
			// 等待 executions 时，tasks 必须已被该事务锁住，且不受 JOIN 计划影响。
			_, err := pool.Exec(ctx, `SELECT id FROM tasks WHERE id = $1::uuid FOR UPDATE NOWAIT`, in.TaskID)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
				t.Fatalf("锁 executions 前没有锁 tasks: %v", err)
			}
			release()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func holdExecution(t *testing.T, ctx context.Context, pool *pgxpool.Pool, executionID string) (func(), int) {
	t.Helper()
	gate, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gate.Rollback(context.Background()) })
	var pid int
	if err := gate.QueryRow(ctx, `SELECT pg_backend_pid() FROM executions WHERE id = $1::uuid FOR UPDATE`, executionID).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return func() {
		if err := gate.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}, pid
}

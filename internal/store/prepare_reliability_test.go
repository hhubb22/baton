package store_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/store"
	"baton/internal/task"
	"baton/migrations"
)

func TestPrepareDeliveryMigrationConservativelyInitializesHistory(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := t.Context()
	repo := store.New(pool)
	owner := mustEmployee(t, ctx, pool, "prepare-migration", "Prepare")
	desk := mustRegister(t, ctx, pool, repo, owner.ID, "Desk", node.RolePC, []string{"pi", "start"})
	unacked := acceptQueued(t, ctx, pool, repo, owner.ID, desk.NodeID, "unacked")
	acked := acceptQueued(t, ctx, pool, repo, owner.ID, desk.NodeID, "acked")
	if _, err := pool.Exec(ctx, `UPDATE dispatch_outbox SET acked_at = now() WHERE id = $1::uuid`, acked.MessageID); err != nil {
		t.Fatal(err)
	}
	// 在独立测试 schema 中还原迁移前的字段，再应用实际迁移。
	if _, err := pool.Exec(ctx, `ALTER TABLE dispatch_outbox DROP COLUMN next_attempt_at, DROP COLUMN may_have_been_sent;
		DROP INDEX dispatch_outbox_node_lease;
		CREATE INDEX dispatch_outbox_due ON dispatch_outbox(created_at, id) WHERE acked_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	sql, err := migrations.Files.ReadFile("0023_prepare_delivery.sql")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, string(sql)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		id       string
		evidence bool
	}{{unacked.MessageID, true}, {acked.MessageID, false}} {
		var evidence, sameTime bool
		var attempts int
		if err := pool.QueryRow(ctx, `SELECT may_have_been_sent, next_attempt_at = created_at, attempts FROM dispatch_outbox WHERE id = $1::uuid`, want.id).Scan(&evidence, &sameTime, &attempts); err != nil {
			t.Fatal(err)
		}
		if evidence != want.evidence || !sameTime || attempts != 0 {
			t.Fatalf("旧记录初始化: %v %v %d", evidence, sameTime, attempts)
		}
	}
}

func TestPrepareBatchNodeFairnessAndDurableRetry(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := t.Context()
	repo := store.New(pool)
	owner := mustEmployee(t, ctx, pool, "prepare-fair", "Prepare")
	addNode := func(name string) node.Identity {
		t.Helper()
		ident := mustRegister(t, ctx, pool, repo, owner.ID, name, node.RolePC, []string{"pi", "start"})
		conn := markOnline(t, ctx, repo, owner.ID, ident)
		if err := repo.SyncNode(ctx, owner.ID, ident.NodeID, conn, name, ident.System, ident.Role, ident.Capabilities); err != nil {
			t.Fatal(err)
		}
		return ident
	}
	a, b := addNode("backlog"), addNode("other")
	first := acceptQueued(t, ctx, pool, repo, owner.ID, a.NodeID, "backlog-0")
	second := acceptQueued(t, ctx, pool, repo, owner.ID, a.NodeID, "backlog-1")
	for i := range 64 {
		acceptQueued(t, ctx, pool, repo, owner.ID, a.NodeID, fmt.Sprintf("backlog-%d", i+2))
	}
	other := acceptQueued(t, ctx, pool, repo, owner.ID, b.NodeID, "other")
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	intents, err := repo.ClaimPrepares(ctx, 5*time.Second, 32)
	if err != nil || len(intents) != 2 {
		t.Fatalf("单节点积压挡住其他节点: %d %v", len(intents), err)
	}
	got := map[string]bool{}
	for _, in := range intents {
		got[in.MessageID] = true
		if len(in.Envelope) == 0 {
			t.Fatal("领取缺少已校验的消息")
		}
		var attempts int
		var evidence bool
		var lease, next time.Time
		if err := pool.QueryRow(ctx, `SELECT attempts, may_have_been_sent, lease_until, next_attempt_at FROM dispatch_outbox WHERE id = $1::uuid`, in.MessageID).Scan(&attempts, &evidence, &lease, &next); err != nil {
			t.Fatal(err)
		}
		if attempts != 1 || !evidence || lease.Before(before.Add(5*time.Second)) || next.Before(lease) {
			t.Fatalf("发送前进度不完整: %d %v %v %v", attempts, evidence, lease, next)
		}
	}
	if !got[first.MessageID] || !got[other.MessageID] {
		t.Fatalf("领取身份: %+v", got)
	}
	if again, err := repo.ClaimPrepares(ctx, 5*time.Second, 32); err != nil || len(again) != 0 {
		t.Fatalf("活动节点租约未限制后续领取: %d %v", len(again), err)
	}
	// 进程在领取后崩溃，重建 Store 仍须遵守保存的重试时间。
	repo = store.New(pool)
	if _, err := pool.Exec(ctx, `UPDATE dispatch_outbox SET lease_until = now() - interval '1 second' WHERE id = $1::uuid`, first.MessageID); err != nil {
		t.Fatal(err)
	}
	in, ok, err := repo.ClaimPrepare(ctx, 5*time.Second)
	if err != nil || !ok || in.MessageID != second.MessageID {
		t.Fatalf("失败项退避未给后续任务机会: %+v %v %v", in, ok, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE dispatch_outbox SET lease_until = now() - interval '1 second',
		next_attempt_at = CASE WHEN id = $2::uuid THEN now() - interval '1 minute' ELSE next_attempt_at END
		WHERE target_node_id = $1::uuid`, a.NodeID, first.MessageID); err != nil {
		t.Fatal(err)
	}
	in, ok, err = repo.ClaimPrepare(ctx, 5*time.Second)
	if err != nil || !ok || in.MessageID != first.MessageID {
		t.Fatalf("丢失回包未重发原身份: %+v %v %v", in, ok, err)
	}
	var attempts int
	var delay float64
	if err := pool.QueryRow(ctx, `SELECT attempts, EXTRACT(EPOCH FROM next_attempt_at - lease_until) FROM dispatch_outbox WHERE id = $1::uuid`, first.MessageID).Scan(&attempts, &delay); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || delay < 3 || delay > 5 {
		t.Fatalf("重试没有退避: %d %f", attempts, delay)
	}
}

func TestPrepareBatchSkipsLockedTaskAndExecution(t *testing.T) {
	for _, relation := range []string{"dispatch_outbox", "tasks", "executions"} {
		for _, sameNode := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/same_node=%t", relation, sameNode), func(t *testing.T) {
				pool := dbtest.Open(t)
				ctx := t.Context()
				repo := store.New(pool)
				owner := mustEmployee(t, ctx, pool, "prepare-locks", "Prepare")
				addNode := func(name string) node.Identity {
					t.Helper()
					ident := mustRegister(t, ctx, pool, repo, owner.ID, name, node.RolePC, []string{"pi", "start"})
					conn := markOnline(t, ctx, repo, owner.ID, ident)
					if err := repo.SyncNode(ctx, owner.ID, ident.NodeID, conn, name, ident.System, ident.Role, ident.Capabilities); err != nil {
						t.Fatal(err)
					}
					return ident
				}
				a := addNode("locked")
				b := a
				if !sameNode {
					b = addNode("healthy")
				}
				locked := acceptQueued(t, ctx, pool, repo, owner.ID, a.NodeID, "locked")
				healthy := acceptQueued(t, ctx, pool, repo, owner.ID, b.NodeID, "healthy")
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				query, id := "SELECT id FROM tasks WHERE id=$1::uuid FOR UPDATE", locked.TaskID
				switch relation {
				case "executions":
					query, id = "SELECT id FROM executions WHERE id=$1::uuid FOR UPDATE", locked.ExecutionID
				case "dispatch_outbox":
					query, id = "SELECT id FROM dispatch_outbox WHERE id=$1::uuid FOR UPDATE", locked.MessageID
				}
				if _, err := tx.Exec(ctx, query, id); err != nil {
					t.Fatal(err)
				}
				claimctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
				defer cancel()
				batch, err := repo.ClaimPrepares(claimctx, 5*time.Second, 32)
				if err != nil || len(batch) != 1 || batch[0].MessageID != healthy.MessageID {
					t.Fatalf("%s 锁阻止后续任务及时领取: %+v %v", relation, batch, err)
				}
				var attempts int
				var evidence bool
				var noLease bool
				if err := pool.QueryRow(ctx, `SELECT attempts, may_have_been_sent, lease_until IS NULL FROM dispatch_outbox WHERE id=$1::uuid`, locked.MessageID).Scan(&attempts, &evidence, &noLease); err != nil {
					t.Fatal(err)
				}
				if attempts != 0 || evidence || !noLease {
					t.Fatal("被锁任务消耗了投递尝试")
				}
				if err := tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				if sameNode {
					if again, err := repo.ClaimPrepares(ctx, 5*time.Second, 32); err != nil || len(again) != 0 {
						t.Fatalf("活动租约未限制同节点领取: %+v %v", again, err)
					}
				}
				if err := repo.SavePrepared(ctx, store.PreparedFact{MessageID: healthy.MessageID, EmployeeID: owner.ID,
					NodeID: b.NodeID, TaskID: healthy.TaskID, ExecutionID: healthy.ExecutionID,
					SessionID: mustUUID(t), StorageGeneration: mustUUID(t)}); err != nil {
					t.Fatal(err)
				}
				batch, err = repo.ClaimPrepares(ctx, 5*time.Second, 32)
				if err != nil || len(batch) != 1 || batch[0].MessageID != locked.MessageID {
					t.Fatalf("释放锁与租约后未恢复原意图: %+v %v", batch, err)
				}
			})
		}
	}
}

func TestPrepareConservativeEvidenceAndFailedClaimRollback(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := t.Context()
	repo := store.New(pool)
	owner := mustEmployee(t, ctx, pool, "prepare-evidence", "Prepare")
	desk := mustRegister(t, ctx, pool, repo, owner.ID, "Desk", node.RolePC, []string{"pi", "start"})
	conn := markOnline(t, ctx, repo, owner.ID, desk)
	if err := repo.SyncNode(ctx, owner.ID, desk.NodeID, conn, desk.DisplayName, desk.System, desk.Role, desk.Capabilities); err != nil {
		t.Fatal(err)
	}
	possible := acceptQueued(t, ctx, pool, repo, owner.ID, desk.NodeID, "possible-send")
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_prepare_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'claim storage failure'; END $$;
		CREATE TRIGGER reject_prepare_claim BEFORE UPDATE ON dispatch_outbox FOR EACH ROW EXECUTE FUNCTION reject_prepare_claim()`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repo.ClaimPrepare(ctx, 5*time.Second); err == nil {
		t.Fatal("数据库故障未返回")
	}
	var attempts int
	var evidence bool
	var noLease bool
	if err := pool.QueryRow(ctx, `SELECT attempts, may_have_been_sent, lease_until IS NULL FROM dispatch_outbox WHERE id = $1::uuid`, possible.MessageID).Scan(&attempts, &evidence, &noLease); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || evidence || !noLease {
		t.Fatal("失败事务改变了持久意图")
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER reject_prepare_claim ON dispatch_outbox`); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := repo.ClaimPrepare(ctx, 5*time.Second); err != nil || !ok {
		t.Fatalf("领取: %v %v", ok, err)
	}
	unsent := acceptQueued(t, ctx, pool, repo, owner.ID, desk.NodeID, "definitely-unsent")
	if _, err := pool.Exec(ctx, `UPDATE dispatch_outbox SET send_deadline = now() - interval '1 second', attempts = 0 WHERE acked_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if err := repo.FailUnsentPrepares(ctx); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct{ id, status string }{{possible.TaskID, task.StatusQueued}, {unsent.TaskID, task.StatusFailed}} {
		rec, err := repo.GetTask(ctx, owner.ID, want.id)
		if err != nil || rec.Status != want.status {
			t.Fatalf("发送证据裁决: %+v %v", rec, err)
		}
	}
}

func TestPrepareBatchLimitAndBoundedRetirement(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := t.Context()
	repo := store.New(pool)
	owner := mustEmployee(t, ctx, pool, "prepare-bounds", "Prepare")
	for i := range 34 {
		name := fmt.Sprintf("node-%d", i)
		desk := mustRegister(t, ctx, pool, repo, owner.ID, name, node.RolePC, []string{"pi", "start"})
		conn := markOnline(t, ctx, repo, owner.ID, desk)
		if err := repo.SyncNode(ctx, owner.ID, desk.NodeID, conn, desk.DisplayName, desk.System, desk.Role, desk.Capabilities); err != nil {
			t.Fatal(err)
		}
		acceptQueued(t, ctx, pool, repo, owner.ID, desk.NodeID, name)
	}
	batch, err := repo.ClaimPrepares(ctx, 5*time.Second, 1000)
	if err != nil || len(batch) != 32 {
		t.Fatalf("批次上限: %d %v", len(batch), err)
	}
	batch, err = repo.ClaimPrepares(ctx, 5*time.Second, 1000)
	if err != nil || len(batch) != 2 {
		t.Fatalf("后页节点: %d %v", len(batch), err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET status = 'cancelled', version = version + 1`); err != nil {
		t.Fatal(err)
	}
	// 维护退役只锁 Outbox，即使另一事务持有 Task 锁也应完成。
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM tasks FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	if err := repo.RetirePrepares(ctx); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM dispatch_outbox WHERE acked_at IS NULL`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 2 {
		t.Fatalf("退役额度: %d", remaining)
	}
	if err := repo.RetirePrepares(ctx); err != nil {
		t.Fatal(err)
	}
	if batch, err := repo.ClaimPrepares(ctx, 5*time.Second, 32); err != nil || len(batch) != 0 {
		t.Fatalf("终态任务恢复派发: %d %v", len(batch), err)
	}
}

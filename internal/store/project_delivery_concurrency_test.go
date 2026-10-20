package store_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
)

func TestProjectDeliveryNodeQuotaSkipsLockedHeads(t *testing.T) {
	for _, tc := range []struct {
		kind, state, query string
	}{
		{protocol.BodyProjectRunStart, "starting", `SELECT id::text FROM agent_runs WHERE node_id=$1 AND state='starting'
 ORDER BY command_next_at,id LIMIT 2 FOR UPDATE`},
		{protocol.BodyProjectRunStop, "finished", `SELECT id::text FROM agent_runs WHERE node_id=$1 AND stop_requested_at IS NOT NULL AND stop_acked_at IS NULL
 ORDER BY command_next_at,id LIMIT 2 FOR UPDATE`},
		{protocol.BodyProjectRunWake, "running", `SELECT r.id::text FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id
 CROSS JOIN LATERAL (SELECT q.wake_next_at,q.id FROM project_agent_input_queue q WHERE q.agent_id=a.id
 AND q.delivered_seq IS NULL AND q.wake_required ORDER BY q.wake_next_at,q.id LIMIT 1) q
 WHERE r.node_id=$1 AND r.state='running' ORDER BY q.wake_next_at,q.id LIMIT 2 FOR NO KEY UPDATE OF a`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			h := deliveryHarness(t)
			for range 3 {
				insertDeliveryRun(t, h, h.src, tc.state)
			}
			locked, err := h.pool.Begin(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locked.Rollback(h.ctx)
			rows, err := locked.Query(h.ctx, tc.query, h.src.NodeID)
			if err != nil {
				t.Fatal(err)
			}
			lockedRuns := map[string]bool{}
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					rows.Close()
					t.Fatal(err)
				}
				lockedRuns[id] = true
			}
			err = rows.Err()
			rows.Close()
			if err != nil || len(lockedRuns) != 2 {
				t.Fatal("没有锁定最早的两个候选", len(lockedRuns), err)
			}
			ctx, cancel := context.WithTimeout(h.ctx, time.Second)
			commands, err := h.repo.ClaimProjectRunCommands(ctx, tc.kind)
			cancel()
			if err != nil || len(commands) != 1 || lockedRuns[commands[0].Command.RunID] {
				t.Fatal("节点内锁定的前两项挡住了第三项", len(commands), err)
			}
			if err = locked.Rollback(h.ctx); err != nil {
				t.Fatal(err)
			}
			if commands = claimDelivery(t, h, tc.kind); len(commands) != 2 {
				t.Fatal("释放锁后没有按节点额度领取剩余工作", len(commands))
			}
		})
	}
}

func TestProjectDeliveryLocksAtMost32RunsOrAgents(t *testing.T) {
	for _, tc := range []struct {
		kind, state, table, trigger, waitQuery string
	}{
		{protocol.BodyProjectRunStart, "starting", "agent_runs", "UPDATE OF command_next_at ON agent_runs", "%UPDATE agent_runs r SET command_attempts=%"},
		{protocol.BodyProjectRunStop, "finished", "agent_runs", "UPDATE OF command_next_at ON agent_runs", "%UPDATE agent_runs r SET command_attempts=%"},
		{protocol.BodyProjectRunWake, "running", "project_agents", "UPDATE OF wake_next_at ON project_agent_input_queue", "%UPDATE project_agent_input_queue q SET wake_attempts=%"},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			h := deliveryHarness(t)
			var later []string
			for i := range 17 {
				src := h.src
				if i > 0 {
					src = projectRunNode(t, h.ctx, h.pool, h.repo, h.owner, fmt.Sprintf("锁预算节点%d", i), true)
				}
				for range 2 {
					p, runID := insertDeliveryRun(t, h, src, tc.state)
					if i == 16 {
						id := runID
						if tc.table == "project_agents" {
							id = p.Agent.ID
						}
						later = append(later, id)
					}
				}
			}
			// 在持久化重试进度前暂停领取，直接观察尚未返回的事务持有哪些行锁。
			if _, err := h.pool.Exec(h.ctx, `CREATE TABLE project_delivery_lock_barrier(id integer PRIMARY KEY);
 INSERT INTO project_delivery_lock_barrier VALUES(1);
 CREATE FUNCTION pause_project_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN PERFORM id FROM project_delivery_lock_barrier WHERE id=1 FOR UPDATE; RETURN NEW; END $$;
 CREATE TRIGGER pause_project_delivery BEFORE `+tc.trigger+` FOR EACH ROW EXECUTE FUNCTION pause_project_delivery()`); err != nil {
				t.Fatal(err)
			}
			barrier, err := h.pool.Begin(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer barrier.Rollback(h.ctx)
			if _, err = barrier.Exec(h.ctx, "SELECT id FROM project_delivery_lock_barrier WHERE id=1 FOR UPDATE"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
			defer cancel()
			type result struct {
				commands []projectagent.RunCommand
				err      error
			}
			done := make(chan result, 1)
			go func() {
				commands, err := h.repo.ClaimProjectRunCommands(ctx, tc.kind)
				done <- result{commands, err}
			}()
			waitProjectLock(t, h, ctx, barrier.Conn().PgConn().PID(), tc.waitQuery)
			observer, err := h.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer observer.Rollback(h.ctx)
			if _, err = observer.Exec(ctx, "SELECT id FROM "+tc.table+" WHERE id=ANY($1::uuid[]) FOR UPDATE NOWAIT", later); err != nil {
				t.Fatal("领取额度之外的节点也被加锁", err)
			}
			if err = observer.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if err = barrier.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			got := <-done
			if got.err != nil || len(got.commands) != 32 {
				t.Fatal("未完成 32 条有界领取", len(got.commands), got.err)
			}
			if remaining := claimDelivery(t, h, tc.kind); len(remaining) != 2 {
				t.Fatal("剩余节点未保持到期", len(remaining))
			}
		})
	}
}

func stoppedLockFixture(t *testing.T) (*toolHarness, protocol.ProjectRuntimeRequest) {
	t.Helper()
	h := deliveryHarness(t)
	if err := h.repo.StopProjectRun(h.ctx, h.owner, h.project.ID); err != nil {
		t.Fatal(err)
	}
	req := h.req
	req.Operation = "stopped"
	return h, req
}

func TestProjectStoppedAckProtectsIdentityDuringRunLockWait(t *testing.T) {
	for _, change := range []string{"node_revocation", "credential_revocation", "connection_replacement"} {
		t.Run(change, func(t *testing.T) {
			h, req := stoppedLockFixture(t)
			locked, err := h.pool.Begin(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locked.Rollback(h.ctx)
			if _, err = locked.Exec(h.ctx, "SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE", req.RunID); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
			defer cancel()
			acked := make(chan error, 1)
			go func() { _, err := h.repo.ProjectRuntime(ctx, h.src, req); acked <- err }()
			waitProjectLock(t, h, ctx, locked.Conn().PgConn().PID(), "%FROM agent_runs WHERE%FOR UPDATE%")
			var ackPID uint32
			if err = h.pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
 AND query LIKE '%FROM agent_runs WHERE%FOR UPDATE%' AND $1=ANY(pg_blocking_pids(pid))`, locked.Conn().PgConn().PID()).Scan(&ackPID); err != nil {
				t.Fatal(err)
			}
			changed := make(chan error, 1)
			waitQuery := "%FROM nodes%FOR UPDATE%"
			switch change {
			case "node_revocation":
				go func() { _, err := h.repo.RevokeNode(ctx, h.owner, h.src.NodeID); changed <- err }()
			case "credential_revocation":
				waitQuery = "%UPDATE node_credentials SET revoked_at=%"
				go func() {
					_, err := h.pool.Exec(ctx, "UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=$1", h.src.CredentialID)
					changed <- err
				}()
			case "connection_replacement":
				waitQuery = "%UPDATE node_presence SET conn_id=%"
				newConnection := mustUUID(t)
				go func() {
					_, err := h.pool.Exec(ctx, "UPDATE node_presence SET conn_id=$2 WHERE node_id=$1", h.src.NodeID, newConnection)
					changed <- err
				}()
			}
			// 认证修改必须等待 stopped 的共享锁；确认可合法地先于修改提交。
			waitProjectLock(t, h, ctx, ackPID, waitQuery)
			if err = locked.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-acked; err != nil {
				t.Fatal("受锁保护的确认失败", err)
			}
			if err = <-changed; err != nil {
				t.Fatal("确认提交后认证修改未完成", err)
			}
			if _, err = h.repo.ProjectRuntime(ctx, h.src, req); !errors.Is(err, projectagent.ErrLeaseLost) {
				t.Fatal("认证修改提交后仍接受旧身份", err)
			}
			var ackedFact bool
			var state, reason string
			if err = h.pool.QueryRow(ctx, "SELECT stop_acked_at IS NOT NULL,state,end_reason FROM agent_runs WHERE id=$1", req.RunID).Scan(&ackedFact, &state, &reason); err != nil || !ackedFact || state != "finished" || reason != "user_stopped" {
				t.Fatal("清理确认更改了历史业务状态", ackedFact, state, reason, err)
			}
		})
	}
}

func TestProjectStoppedAckRejectsCredentialExpiryDuringRunLockWait(t *testing.T) {
	h, req := stoppedLockFixture(t)
	locked, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(h.ctx)
	if _, err = locked.Exec(h.ctx, "SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE", req.RunID); err != nil {
		t.Fatal(err)
	}
	var expires time.Time
	if err = h.pool.QueryRow(h.ctx, "UPDATE node_credentials SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at", h.src.CredentialID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := h.repo.ProjectRuntime(ctx, h.src, req); done <- err }()
	waitProjectLock(t, h, ctx, locked.Conn().PgConn().PID(), "%FROM agent_runs WHERE%FOR UPDATE%")
	var now time.Time
	if err = h.pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); err != nil {
		t.Fatal(err)
	}
	if remaining := expires.Sub(now) + 20*time.Millisecond; remaining > 0 {
		time.Sleep(remaining)
	}
	if err = locked.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, projectagent.ErrLeaseLost) {
		t.Fatal("凭据在 Run 锁等待中过期后仍接受确认", err)
	}
	var acked bool
	if err = h.pool.QueryRow(ctx, "SELECT stop_acked_at IS NOT NULL FROM agent_runs WHERE id=$1", req.RunID).Scan(&acked); err != nil || acked {
		t.Fatal("凭据过期的确认写入了清理事实", acked, err)
	}
}

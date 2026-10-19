package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectRunRejectsLeaseExpiredDuringNodeLockWait(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "lease-lock-wait", "主动输入")
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	request := runtimeRequest(t, ctx, pool, p.Agent.ID, "renew")
	locked, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(ctx)
	if _, err = locked.Exec(ctx, `SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, src.NodeID); err != nil {
		t.Fatal(err)
	}
	var expires time.Time
	if err = pool.QueryRow(ctx, `UPDATE project_agents SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING lease_until`, p.Agent.ID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, err := repo.ProjectRuntime(ctx, src, request); result <- err }()
	// 取得 Agent 锁后，认证还要等待节点锁；测试把这次等待延长到租期之后。
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF n,cr,np%' AND $1=ANY(pg_blocking_pids(pid)))`, locked.Conn().PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("请求未等待节点锁: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("请求没有进入节点锁等待")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if delay := time.Until(expires) + 50*time.Millisecond; delay > 0 {
		time.Sleep(delay)
	}
	if err = locked.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if !errors.Is(err, projectagent.ErrLeaseLost) {
			t.Fatalf("等待中已过期的租约仍被接受: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("释放节点锁后请求未返回")
	}
	var after time.Time
	if err = pool.QueryRow(ctx, `SELECT lease_until FROM project_agents WHERE id=$1`, p.Agent.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(expires) {
		t.Fatalf("失败的续租修改了期限: 原 %s，现 %s", expires, after)
	}
}

func TestProjectRunClaimRollsBackWhenLeaseExpiresDuringQueueLockWait(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "claim-lock-wait", "保留输入")
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	request := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
	locked, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(ctx)
	if _, err = locked.Exec(ctx, `SELECT id FROM project_agent_input_queue WHERE agent_id=$1 FOR UPDATE`, p.Agent.ID); err != nil {
		t.Fatal(err)
	}
	var expires time.Time
	if err = pool.QueryRow(ctx, `UPDATE project_agents SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING lease_until`, p.Agent.ID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, err := repo.ProjectRuntime(ctx, src, request); result <- err }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE project_agent_input_queue%' AND $1=ANY(pg_blocking_pids(pid)))`, locked.Conn().PgConn().PID()).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("领取未等待输入队列锁: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("领取没有进入输入队列锁等待")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if delay := time.Until(expires) + 50*time.Millisecond; delay > 0 {
		time.Sleep(delay)
	}
	if err = locked.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if !errors.Is(err, projectagent.ErrLeaseLost) {
			t.Fatalf("领取在锁等待后提交了过期租约: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("释放队列锁后领取未返回")
	}
	var pending, events int
	var next int64
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND delivered_seq IS NULL`, p.Agent.ID).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM conversation_events WHERE conversation_id=$1`, p.Conversation.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT next_seq FROM conversations WHERE id=$1`, p.Conversation.ID).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if pending != 1 || events != 0 || next != 1 {
		t.Fatalf("过期领取未完整回滚: pending=%d events=%d next_seq=%d", pending, events, next)
	}
}

func TestProjectUpdatedNotificationFitsCanonicalJSONBoundary(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	goal := strings.Repeat(`"`, 933) + strings.Repeat("x", 3072-933)
	updated, err := repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Goal: &goal})
	if err != nil {
		t.Fatalf("合法目标因通知JSON规范表示超限而拒绝: %v", err)
	}
	if updated.Goal != goal {
		t.Fatal("Project完整目标被通知裁剪影响")
	}
	var raw []byte
	var size int
	if err = pool.QueryRow(ctx, `SELECT payload,octet_length(payload::text) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='project_updated'`, p.Agent.ID).Scan(&raw, &size); err != nil {
		t.Fatal(err)
	}
	var notification struct {
		Goal          string `json:"goal"`
		OriginalBytes int    `json:"original_goal_bytes"`
		Truncated     bool   `json:"truncated"`
	}
	if err = json.Unmarshal(raw, &notification); err != nil {
		t.Fatal(err)
	}
	if size > 4<<10 || notification.OriginalBytes != len(goal) || !notification.Truncated || !strings.HasPrefix(notification.Goal, `"`) || !strings.HasSuffix(notification.Goal, "x") {
		t.Fatalf("通知缺少限长或原文信息: size=%d original=%d truncated=%v", size, notification.OriginalBytes, notification.Truncated)
	}
	stored, err := repo.Project(ctx, owner, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Goal != goal {
		t.Fatal("保存的完整目标发生变化")
	}
}

func TestProjectRunStoppedAcksWithSaturatedConnectionPool(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "stopped-pool", "主动输入")
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	request := runtimeRequest(t, ctx, pool, p.Agent.ID, "stopped")
	if err := repo.StopProjectRun(ctx, owner, p.ID); err != nil {
		t.Fatal(err)
	}
	cfg := pool.Config()
	cfg.MaxConns = 8
	var acquired atomic.Int32
	barrier := make(chan struct{})
	type acquisitionKey struct{}
	// 每个请求先独占一个连接，所有连接都被占用后同时开始事务。
	cfg.BeforeAcquire = func(ctx context.Context, _ *pgx.Conn) bool {
		first, ok := ctx.Value(acquisitionKey{}).(*atomic.Bool)
		if ok && first.CompareAndSwap(false, true) {
			if acquired.Add(1) == cfg.MaxConns {
				close(barrier)
			}
			select {
			case <-barrier:
			case <-ctx.Done():
				return false
			}
		}
		return true
	}
	burst, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer burst.Close()
	burstRepo := store.New(burst)
	var wg sync.WaitGroup
	results := make(chan error, int(cfg.MaxConns))
	for range cfg.MaxConns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			requestCtx, cancel := context.WithTimeout(context.WithValue(ctx, acquisitionKey{}, new(atomic.Bool)), 5*time.Second)
			defer cancel()
			_, err := burstRepo.ProjectRuntime(requestCtx, src, request)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Errorf("连接池满额时停止回执失败: %v", err)
		}
	}
	var acked bool
	if err = pool.QueryRow(ctx, `SELECT stop_acked_at IS NOT NULL FROM agent_runs WHERE id=$1`, request.RunID).Scan(&acked); err != nil {
		t.Fatal(err)
	}
	if !acked {
		t.Fatal("并发停止回执未持久确认")
	}
}

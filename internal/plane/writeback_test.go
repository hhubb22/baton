package plane

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/task"
	"github.com/google/uuid"
)

type commentAPI struct {
	mu                 sync.Mutex
	rows               []comment
	posts              int
	unavailable        bool
	lose               bool
	hide               bool
	conflictWrongScope bool
}

func setupWriteback(t *testing.T) (*fixture, *commentAPI, string) {
	f := newFixture(t)
	_, accepted := f.send(f.event("updated", "state"), uuid.NewString())
	if accepted.TaskID == "" {
		t.Fatal("未接受任务")
	}
	a := &commentAPI{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.unavailable {
			w.WriteHeader(503)
			fmt.Fprint(w, "secret unavailable body")
			return
		}
		if r.Header.Get("X-API-Key") != f.cfg.APIKey {
			t.Error("缺少认证")
		}
		if r.Method == "POST" {
			a.posts++
			var c comment
			if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
				t.Error(err)
			}
			for _, old := range a.rows {
				if old.ExternalID == c.ExternalID {
					w.WriteHeader(409)
					_ = json.NewEncoder(w).Encode(old)
					return
				}
			}
			c.ID = uuid.NewString()
			c.Issue = f.cur.ID
			c.Project = f.cfg.ProjectID
			c.Workspace = f.cfg.WorkspaceID
			if a.conflictWrongScope {
				c.Issue = uuid.NewString()
			}
			a.rows = append(a.rows, c)
			if a.lose {
				a.lose = false
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_ = conn.Close()
				return
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(c)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/comments/") {
			rows := a.rows
			if a.hide {
				rows = []comment{}
			}
			if rows == nil {
				rows = []comment{}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"results": rows, "next_page_results": false})
			return
		}
		for _, c := range a.rows {
			if strings.HasSuffix(r.URL.Path, "/"+c.ID+"/") {
				_ = json.NewEncoder(w).Encode(c)
				return
			}
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	f.cfg.URL = srv.URL
	f.cfg.BatonURL = "https://baton.example.test"
	f.restart(f.repo)
	return f, a, accepted.TaskID
}

func writebackDue(t *testing.T, f *fixture) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(), `UPDATE plane_outbox SET next_attempt_at=now() WHERE delivered_at IS NULL`); err != nil {
		t.Fatal(err)
	}
}
func flushWriteback(t *testing.T, f *fixture) {
	t.Helper()
	if err := f.svc.retryWritebacks(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestWritebackLostResponseRecoveryAndPrivacy(t *testing.T) {
	f, a, taskID := setupWriteback(t)
	a.mu.Lock()
	a.lose = true
	a.mu.Unlock()
	flushWriteback(t, f)
	a.mu.Lock()
	if a.posts != 1 || len(a.rows) != 1 {
		t.Fatalf("写入 %d 评论 %d", a.posts, len(a.rows))
	}
	a.mu.Unlock()
	var pending int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM plane_outbox WHERE delivered_at IS NULL`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("未保留待回写：%d %v", pending, err)
	}
	f.restart(f.repo)
	writebackDue(t, f)
	flushWriteback(t, f)
	a.mu.Lock()
	if a.posts != 1 {
		t.Fatal("响应丢失后未先查询评论")
	}
	a.mu.Unlock()
	if _, err := f.repo.RequestCancel(context.Background(), f.cfg.Actors[0].EmployeeID, taskID); err != nil {
		t.Fatal(err)
	}
	rec, err := f.repo.GetTask(context.Background(), f.cfg.Actors[0].EmployeeID, taskID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.ResolveTask(context.Background(), f.cfg.Actors[0].EmployeeID, taskID, task.ResolveInput{ExpectedVersion: rec.Version, Status: task.StatusCompleted, Summary: "结果 <script> password=private-token", Reason: "核查", Evidence: []task.ResultRef{{StorageRef: "private-session-path", ResourceID: "private-session-history", Note: "private-command-output", AccessStatus: "available"}}})
	if err != nil {
		t.Fatal(err)
	}
	flushWriteback(t, f)
	a.mu.Lock()
	last := a.rows[len(a.rows)-1]
	a.mu.Unlock()
	if !strings.Contains(last.HTML, "待员工验收") || !strings.Contains(last.HTML, "查看任务证据") || !strings.Contains(last.HTML, "&lt;script&gt;") {
		t.Fatalf("结果评论：%s", last.HTML)
	}
	for _, s := range []string{"private-token", "private-session-path", "private-session-history", "private-command-output", "<script>"} {
		if strings.Contains(last.HTML, s) {
			t.Fatalf("评论泄露 %s", s)
		}
	}
	rec, err = f.repo.GetTask(context.Background(), f.cfg.Actors[0].EmployeeID, taskID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.AcceptResult(context.Background(), f.cfg.Actors[0].EmployeeID, taskID, task.AcceptanceInput{ExpectedVersion: rec.Version, Decision: "rejected", Comment: "现场结果未通过"}); err != nil {
		t.Fatal(err)
	}
	flushWriteback(t, f)
	a.mu.Lock()
	last = a.rows[len(a.rows)-1]
	a.mu.Unlock()
	if !strings.Contains(last.HTML, "员工验收不通过") {
		t.Fatal("验收意见未回写")
	}
	f.assertTasks(1)
}

func TestWritebackUnavailableConflictAndConcurrentRecovery(t *testing.T) {
	f, a, _ := setupWriteback(t)
	a.mu.Lock()
	a.unavailable = true
	a.mu.Unlock()
	flushWriteback(t, f)
	a.mu.Lock()
	if a.posts != 0 {
		t.Fatal("查询失败仍写入")
	}
	a.mu.Unlock()
	a.mu.Lock()
	a.unavailable = false
	a.hide = true
	a.lose = true
	a.mu.Unlock()
	writebackDue(t, f)
	flushWriteback(t, f)
	a.mu.Lock()
	if a.posts != 1 || len(a.rows) != 1 {
		t.Fatal("未写入第一条")
	}
	a.mu.Unlock()
	writebackDue(t, f)
	flushWriteback(t, f)
	a.mu.Lock()
	if a.posts != 2 || len(a.rows) != 1 {
		t.Fatalf("409 恢复：%d %d", a.posts, len(a.rows))
	}
	a.mu.Unlock()
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			if err := f.svc.retryWritebacks(context.Background()); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	f.assertTasks(1)
}

func TestWritebackScopeMismatchRemainsPending(t *testing.T) {
	f, a, _ := setupWriteback(t)
	a.mu.Lock()
	a.conflictWrongScope = true
	a.mu.Unlock()
	flushWriteback(t, f)
	var delivered int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM plane_outbox WHERE delivered_at IS NOT NULL`).Scan(&delivered); err != nil || delivered != 0 {
		t.Fatalf("错误评论被确认 %d %v", delivered, err)
	}
}

func TestWritebackTransactionRollbackAndLeaseRecovery(t *testing.T) {
	f, _, taskID := setupWriteback(t)
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), `UPDATE tasks SET version=version+1,status='running' WHERE id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), `SET CONSTRAINTS ALL IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM plane_outbox`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("回滚留下快照 %d %v", n, err)
	}
	item, ok, err := f.svc.claimWriteback(context.Background())
	if err != nil || !ok {
		t.Fatal(err)
	}
	if _, ok, err := f.svc.claimWriteback(context.Background()); err != nil || ok {
		t.Fatalf("重复领取 %v %v", ok, err)
	}
	f.restart(f.repo)
	writebackDue(t, f)
	flushWriteback(t, f)
	var id string
	if err := f.pool.QueryRow(context.Background(), `SELECT id::text FROM plane_outbox WHERE delivered_at IS NOT NULL`).Scan(&id); err != nil || id != item.ID {
		t.Fatalf("租约恢复 %s %v", id, err)
	}
}

func TestConcurrentPlaneLinkAndTaskUpdatePreserveLatestSnapshot(t *testing.T) {
	f, _, taskID := setupWriteback(t)
	ctx := context.Background()
	var trigger string
	if err := f.pool.QueryRow(ctx, `SELECT trigger_id FROM plane_triggers WHERE task_id=$1`, taskID).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE plane_triggers SET task_id=NULL WHERE trigger_id=$1`, trigger); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM plane_outbox`); err != nil {
		t.Fatal(err)
	}
	taskTx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = taskTx.Rollback(ctx) }()
	if _, err := taskTx.Exec(ctx, `UPDATE tasks SET version=version+1,status='running' WHERE id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	linkTx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = linkTx.Rollback(ctx) }()
	var pid int
	if err := linkTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := linkTx.Exec(ctx, `UPDATE plane_triggers SET task_id=$2 WHERE trigger_id=$1`, trigger, taskID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- linkTx.Commit(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-done:
			t.Fatalf("关联提交未等待并行任务变更：%v", err)
		default:
		}
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1))>0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("没有观察到关联等待任务锁")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := taskTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var latest bool
	if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks t JOIN plane_outbox o ON o.task_id=t.id AND o.task_version=t.version WHERE t.id=$1 AND o.snapshot->>'status'='running')`, taskID).Scan(&latest); err != nil || !latest {
		t.Fatalf("最新结果没有回写快照 %v %v", latest, err)
	}
}

func TestWritebackFailureIncludesReasonAndKnownImpact(t *testing.T) {
	f, a, taskID := setupWriteback(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `UPDATE tasks SET status='failed',error_code='queue_timeout',error_message='private-database-error',version=version+1 WHERE id=$1`, taskID); err != nil {
		t.Fatal(err)
	}
	flushWriteback(t, f)
	a.mu.Lock()
	defer a.mu.Unlock()
	last := a.rows[len(a.rows)-1]
	if !strings.Contains(last.HTML, "排队超时") || !strings.Contains(last.HTML, "未获启动授权") || strings.Contains(last.HTML, "private-database-error") {
		t.Fatalf("失败原因及影响：%s", last.HTML)
	}
}

package store_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/store"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAcceptReplayAndDefaults(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := store.New(pool)
	assertTaskSchema(t, ctx, pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	early := mustRegister(t, ctx, pool, repo, alice.ID, "Early", node.RolePC, []string{"pi", "codex", "start"})
	later := mustRegister(t, ctx, pool, repo, alice.ID, "Later", node.RolePC, []string{"pi", "codex", "start"})
	ubuntu := mustRegister(t, ctx, pool, repo, alice.ID, "Build", node.RoleUbuntu, []string{"pi", "start"})
	bobNode := mustRegister(t, ctx, pool, repo, bob.ID, "Bob Hidden", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, early.NodeID, "pi")
	setDefaultAgent(t, ctx, pool, later.NodeID, "pi")
	setDefaultAgent(t, ctx, pool, ubuntu.NodeID, "pi")
	setDefaultAgent(t, ctx, pool, bobNode.NodeID, "pi")
	if defaultPC(t, ctx, pool, alice.ID) != early.NodeID {
		t.Fatal("最早的 PC 没有成为默认值")
	}
	var presence int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM node_presence WHERE node_id = $1::uuid`, early.NodeID).Scan(&presence); err != nil {
		t.Fatal(err)
	}
	if presence != 0 {
		t.Fatal("测试节点不应该已经在线")
	}

	first, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "job-1", Description: "调查天线"})
	if err != nil {
		t.Fatal(err)
	}
	if first.TargetNodeID != early.NodeID || first.AgentType != "pi" || first.Status != task.StatusQueued || first.Version != 1 {
		t.Fatalf("接受结果不正确: %+v", first)
	}
	if first.ExecutionTimeoutSeconds != task.DefaultExecutionTimeoutSeconds {
		t.Fatalf("执行期限是 %d", first.ExecutionTimeoutSeconds)
	}
	if first.QueueExpiresAt.Sub(first.AcceptedAt) != time.Duration(task.DefaultQueueTimeoutSeconds)*time.Second {
		t.Fatalf("排队到期时间是 %s", first.QueueExpiresAt.Sub(first.AcceptedAt))
	}
	assertAcceptedShape(t, ctx, pool, alice.ID, first)
	execID := executionID(t, ctx, pool, first.TaskID)

	if _, err := repo.SetDefaultPC(ctx, alice.ID, later.NodeID); err != nil {
		t.Fatal(err)
	}
	setDefaultAgent(t, ctx, pool, early.NodeID, "codex")
	setDefaultAgent(t, ctx, pool, later.NodeID, "codex")
	replay, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "job-1", Description: "调查天线"})
	if err != nil {
		t.Fatal(err)
	}
	if replay.TaskID != first.TaskID || replay.TargetNodeID != early.NodeID || replay.AgentType != "pi" {
		t.Fatalf("重试重新解析了默认值: %+v", replay)
	}
	if executionID(t, ctx, pool, first.TaskID) != execID || countFor(t, ctx, pool, alice.ID) != (taskFacts{1, 1, 1, 1, 1}) {
		t.Fatal("重试产生了第二份执行或投递")
	}

	timeout := task.DefaultQueueTimeoutSeconds
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "job-1", Description: "调查天线", QueueTimeoutSeconds: &timeout,
	})
	assertConflict(t, err, first.TaskID)
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "job-1", Description: "另一件事"})
	assertConflict(t, err, first.TaskID)
	if countFor(t, ctx, pool, alice.ID).tasks != 1 || targetOf(t, ctx, pool, first.TaskID) != early.NodeID {
		t.Fatal("冲突请求改写了原任务")
	}

	next, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "job-2", Description: "下一件"})
	if err != nil {
		t.Fatal(err)
	}
	if next.TaskID == first.TaskID || next.TargetNodeID != later.NodeID || next.AgentType != "codex" {
		t.Fatalf("新请求没有使用新的默认值: %+v", next)
	}

	upper := strings.ToUpper(early.NodeID)
	agent := "pi"
	explicit, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "job-3", Description: "指定节点", TargetNodeID: &upper, AgentType: &agent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if explicit.TargetNodeID != early.NodeID || explicit.AgentType != "pi" {
		t.Fatalf("显式目标没有固定: %+v", explicit)
	}
	again, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "job-3", Description: "指定节点", TargetNodeID: &early.NodeID, AgentType: &agent,
	})
	if err != nil || again.TaskID != explicit.TaskID {
		t.Fatalf("大小写不同的同一节点没有命中原任务: %v %+v", err, again)
	}

	onUbuntu, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "job-ubuntu", Description: "在开发节点", TargetNodeID: &ubuntu.NodeID,
	})
	if err != nil || onUbuntu.TargetNodeID != ubuntu.NodeID || onUbuntu.AgentType != "pi" {
		t.Fatalf("显式 Ubuntu 目标没有被接受: %v %+v", err, onUbuntu)
	}

	child, err := repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "job-child", Description: "子任务", ParentTaskID: &first.TaskID, AgentType: &agent, TargetNodeID: &later.NodeID,
	})
	if err != nil || child.ParentTaskID == nil || *child.ParentTaskID != first.TaskID {
		t.Fatalf("来源任务没有保存: %v %+v", err, child)
	}

	bobTask, err := repo.AcceptTask(ctx, bob.ID, task.Input{RequestID: "job-1", Description: "调查天线"})
	if err != nil || bobTask.TaskID == first.TaskID || bobTask.TargetNodeID != bobNode.NodeID {
		t.Fatalf("另一个员工没有得到自己的任务: %v %+v", err, bobTask)
	}
	before := countFor(t, ctx, pool, alice.ID)
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "cross-parent", Description: "越权来源", ParentTaskID: &bobTask.TaskID, AgentType: &agent, TargetNodeID: &early.NodeID,
	})
	assertCode(t, err, task.CodeForbidden, "")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{
		RequestID: "cross-node", Description: "越权节点", TargetNodeID: &bobNode.NodeID, AgentType: &agent,
	})
	assertCode(t, err, task.CodeForbidden, "")
	if countFor(t, ctx, pool, alice.ID) != before {
		t.Fatal("被拒绝的跨员工引用写入了任务")
	}
}

func TestAcceptRejectsBeforeStart(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := store.New(pool)
	repo.SetTaskCommitHook(func(context.Context) error {
		t.Errorf("拒绝的请求进入了提交")
		return errors.New("should not commit")
	})
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	carol := mustEmployee(t, ctx, pool, "carol", "Carol")
	pc := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	bobNode := mustRegister(t, ctx, pool, repo, bob.ID, "Other", node.RolePC, []string{"pi", "start"})
	_ = mustRegister(t, ctx, pool, repo, carol.ID, "Build", node.RoleUbuntu, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, bobNode.NodeID, "pi")

	_, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "no-agent", Description: "调查"})
	assertCode(t, err, task.CodeInvalidRequest, "agent_type")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "bad-agent", Description: "调查", AgentType: strPtr("codex")})
	assertCode(t, err, task.CodeUnsupported, "agent_type")
	setDefaultAgent(t, ctx, pool, pc.NodeID, "kiro")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "bad-default", Description: "调查"})
	assertCode(t, err, task.CodeUnsupported, "agent_type")
	if _, err := pool.Exec(ctx, `UPDATE nodes SET revoked_at = now() WHERE id = $1::uuid`, pc.NodeID); err != nil {
		t.Fatal(err)
	}
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "revoked", Description: "调查", TargetNodeID: &pc.NodeID, AgentType: strPtr("pi")})
	assertCode(t, err, task.CodeInvalidTarget, "target_node_id")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "other-node", Description: "调查", TargetNodeID: &bobNode.NodeID, AgentType: strPtr("pi")})
	assertCode(t, err, task.CodeForbidden, "target_node_id")
	missing := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "missing-node", Description: "调查", TargetNodeID: &missing, AgentType: strPtr("pi")})
	assertCode(t, err, task.CodeInvalidTarget, "target_node_id")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "blank", Description: "   "})
	assertCode(t, err, task.CodeInvalidRequest, "description")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "zero", Description: "调查", QueueTimeoutSeconds: intPtr(0), AgentType: strPtr("pi"), TargetNodeID: &bobNode.NodeID})
	assertCode(t, err, task.CodeInvalidRequest, "queue_timeout_seconds")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "device", Description: "调查", DeviceNames: &[]string{"meter"}})
	assertCode(t, err, task.CodeInvalidRequest, "authorization_scope")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "bad-session", Description: "调查", SourceSessionID: strPtr("session")})
	assertCode(t, err, task.CodeInvalidRequest, "source_session_id")
	sessionID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "session", Description: "调查", SourceSessionID: &sessionID, AgentType: strPtr("pi"), TargetNodeID: &bobNode.NodeID})
	assertCode(t, err, task.CodeInvalidTarget, "source_session_id")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "missing-parent", Description: "调查", ParentTaskID: &missing, AgentType: strPtr("pi"), TargetNodeID: &bobNode.NodeID})
	assertCode(t, err, task.CodeInvalidTarget, "parent_task_id")
	_, err = repo.AcceptTask(ctx, carol.ID, task.Input{RequestID: "no-pc", Description: "调查", AgentType: strPtr("pi")})
	assertCode(t, err, task.CodeInvalidTarget, "target_node_id")
	if countFor(t, ctx, pool, alice.ID).tasks != 0 || countFor(t, ctx, pool, carol.ID).tasks != 0 || countAll(t, ctx, pool).outbox != 0 {
		t.Fatal("启动前被拒绝的请求留下了任务或投递")
	}
}

func TestAcceptMultilineText(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	pc := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, pc.NodeID, "pi")

	scope := "只读\n不改配置"
	outputs := "结论\r\n证据\t引用"
	in := task.Input{
		RequestID:          "multi-1",
		Description:        "第一行\n第二行\r\n\t第三行",
		AuthorizationScope: &scope,
		ExpectedOutputs:    &outputs,
	}
	prepared, err := task.Prepare(in)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := repo.AcceptTask(ctx, alice.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Description != in.Description || rec.AuthorizationScope == nil || *rec.AuthorizationScope != scope ||
		rec.ExpectedOutputs == nil || *rec.ExpectedOutputs != outputs {
		t.Fatalf("多行字段没有原样保存: %+v", rec)
	}
	var taskHash, tombHash []byte
	if err := pool.QueryRow(ctx, `
		SELECT t.request_hash, tb.request_hash
		FROM tasks t
		JOIN request_tombstones tb ON tb.employee_id = t.employee_id AND tb.request_id = t.request_id
		WHERE t.id = $1::uuid`, rec.TaskID).Scan(&taskHash, &tombHash); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(taskHash, prepared.Hash) || !bytes.Equal(tombHash, prepared.Hash) {
		t.Fatal("多行说明没有进入 request_hash")
	}
	replay, err := repo.AcceptTask(ctx, alice.ID, in)
	if err != nil || replay.TaskID != rec.TaskID || replay.Description != in.Description {
		t.Fatalf("多行重试没有返回原任务: %v %+v", err, replay)
	}
	changed := in
	changed.Description = "第一行\n第二行\n\t第三行"
	_, err = repo.AcceptTask(ctx, alice.ID, changed)
	assertConflict(t, err, rec.TaskID)

	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "ctrl-description", Description: "调查\x01"})
	assertCode(t, err, task.CodeInvalidRequest, "description")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "ctrl-scope", Description: "调查", AuthorizationScope: strPtr("范围\v")})
	assertCode(t, err, task.CodeInvalidRequest, "authorization_scope")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "ctrl-outputs", Description: "调查", ExpectedOutputs: strPtr("产物\x7f")})
	assertCode(t, err, task.CodeInvalidRequest, "expected_outputs")
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "too-long", Description: strings.Repeat("测", 32769)})
	assertCode(t, err, task.CodeInvalidRequest, "description")
	if countFor(t, ctx, pool, alice.ID).tasks != 1 {
		t.Fatal("被拒绝的说明写入了任务")
	}

	long := strings.Repeat("测", 32767) + "\n"
	if utf8.RuneCountInString(long) != 32768 {
		t.Fatalf("边界长度是 %d", utf8.RuneCountInString(long))
	}
	longIn := task.Input{RequestID: "long", Description: long, AuthorizationScope: &long, ExpectedOutputs: &long}
	longRec, err := repo.AcceptTask(ctx, alice.ID, longIn)
	if err != nil || longRec.Description != long {
		t.Fatalf("32768 个字符没有被接受: %v", err)
	}
	var length int
	if err := pool.QueryRow(ctx, `SELECT char_length(description) FROM tasks WHERE id = $1::uuid`, longRec.TaskID).Scan(&length); err != nil {
		t.Fatal(err)
	}
	if length != 32768 {
		t.Fatalf("保存后的长度是 %d", length)
	}

	_, err = pool.Exec(ctx, `UPDATE tasks SET description = $2 WHERE id = $1::uuid`, rec.TaskID, rec.Description+"\x01")
	assertCheckViolation(t, err, "tasks_description_text")
	_, err = pool.Exec(ctx, `UPDATE tasks SET authorization_scope = $2 WHERE id = $1::uuid`, rec.TaskID, scope+"\x0b")
	assertCheckViolation(t, err, "tasks_authorization_scope_text")
	_, err = pool.Exec(ctx, `UPDATE tasks SET expected_outputs = $2 WHERE id = $1::uuid`, rec.TaskID, outputs+"\u0085")
	assertCheckViolation(t, err, "tasks_expected_outputs_text")
	_, err = pool.Exec(ctx, `UPDATE tasks SET description = $2 WHERE id = $1::uuid`, longRec.TaskID, long+"多")
	assertCheckViolation(t, err, "tasks_description_text")
	var stored string
	if err := pool.QueryRow(ctx, `SELECT description FROM tasks WHERE id = $1::uuid`, rec.TaskID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != in.Description {
		t.Fatalf("约束拒绝后说明被改写: %q", stored)
	}
}

func TestAcceptUncommittedIsInvisible(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	pc := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, pc.NodeID, "pi")

	seen := make(chan struct{})
	release := make(chan error, 1)
	repo.SetTaskCommitHook(func(ctx context.Context) error {
		close(seen)
		select {
		case err := <-release:
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	errCh := make(chan error, 1)
	go func() {
		_, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "hold", Description: "保持"})
		errCh <- err
	}()
	select {
	case <-seen:
	case <-time.After(15 * time.Second):
		t.Fatal("没有进入提交")
	}
	if got := countAll(t, ctx, pool); got != (taskFacts{}) {
		t.Fatalf("未提交时已经可见: %+v", got)
	}
	release <- errors.New("commit-hook-secret")
	if err := <-errCh; err == nil {
		t.Fatal("失败的提交返回了接受记录")
	}
	if got := countAll(t, ctx, pool); got != (taskFacts{}) {
		t.Fatalf("回滚后仍有记录: %+v", got)
	}

	repo.SetTaskCommitHook(nil)
	rec, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "hold", Description: "保持"})
	if err != nil || rec.Status != task.StatusQueued {
		t.Fatal(err)
	}
	if got := countAll(t, ctx, pool); got != (taskFacts{1, 1, 1, 1, 1}) {
		t.Fatalf("提交成功后的记录不完整: %+v", got)
	}
}

func TestAcceptConcurrent(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	pc := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, pc.NodeID, "pi")

	const n = 8
	same := task.Input{RequestID: "same", Description: "同一件事"}
	start := make(chan struct{})
	var wg sync.WaitGroup
	type result struct {
		rec task.Record
		err error
	}
	results := make(chan result, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rec, err := repo.AcceptTask(ctx, alice.ID, same)
			results <- result{rec, err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var taskID string
	for res := range results {
		if res.err != nil {
			t.Fatal(res.err)
		}
		if taskID == "" {
			taskID = res.rec.TaskID
		}
		if res.rec.TaskID != taskID || res.rec.TargetNodeID != pc.NodeID {
			t.Fatalf("并发相同请求得到了不同任务: %+v", res.rec)
		}
	}
	if countFor(t, ctx, pool, alice.ID) != (taskFacts{1, 1, 1, 1, 1}) {
		t.Fatal("并发相同请求产生了多份执行")
	}

	start = make(chan struct{})
	type conflictResult struct {
		desc string
		rec  task.Record
		err  error
	}
	conflicts := make(chan conflictResult, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		desc := fmt.Sprintf("版本-%d", i)
		go func() {
			defer wg.Done()
			<-start
			rec, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "race", Description: desc})
			conflicts <- conflictResult{desc, rec, err}
		}()
	}
	close(start)
	wg.Wait()
	close(conflicts)
	wins := 0
	var winner task.Record
	var rejected []error
	for res := range conflicts {
		if res.err == nil {
			wins++
			winner = res.rec
			continue
		}
		rejected = append(rejected, res.err)
	}
	if wins != 1 || len(rejected) != n-1 {
		t.Fatalf("冲突并发成功了 %d 次，拒绝了 %d 次", wins, len(rejected))
	}
	for _, err := range rejected {
		assertConflict(t, err, winner.TaskID)
	}
	var stored string
	if err := pool.QueryRow(ctx, `SELECT description FROM tasks WHERE id = $1::uuid`, winner.TaskID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != winner.Description || countFor(t, ctx, pool, alice.ID).tasks != 2 {
		t.Fatalf("冲突并发留下的任务不正确: %s", stored)
	}
}

func TestTombstoneOutlivesTask(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	pc := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, pc.NodeID, "pi")
	rec, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "kept", Description: "保留去重"})
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`DELETE FROM dispatch_outbox WHERE task_id = $1::uuid`,
		`DELETE FROM task_events WHERE task_id = $1::uuid`,
		`DELETE FROM executions WHERE task_id = $1::uuid`,
		`DELETE FROM tasks WHERE id = $1::uuid`,
	} {
		if _, err := pool.Exec(ctx, stmt, rec.TaskID); err != nil {
			t.Fatal(err)
		}
	}
	if countAll(t, ctx, pool).tombstones != 1 {
		t.Fatal("删除明细时墓碑也被删了")
	}
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "kept", Description: "保留去重"})
	assertConflict(t, err, rec.TaskID)
	_, err = repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "kept", Description: "不同内容"})
	assertConflict(t, err, rec.TaskID)
	if got := countAll(t, ctx, pool); got.tasks != 0 || got.outbox != 0 || got.tombstones != 1 {
		t.Fatalf("墓碑没有挡住新任务: %+v", got)
	}
}

type taskFacts struct {
	tasks, events, executions, outbox, tombstones int
}

func countFor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID string) taskFacts {
	t.Helper()
	var got taskFacts
	err := pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM tasks WHERE employee_id = $1::uuid),
			(SELECT COUNT(*) FROM task_events WHERE employee_id = $1::uuid),
			(SELECT COUNT(*) FROM executions WHERE employee_id = $1::uuid),
			(SELECT COUNT(*) FROM dispatch_outbox WHERE employee_id = $1::uuid),
			(SELECT COUNT(*) FROM request_tombstones WHERE employee_id = $1::uuid)`, employeeID).Scan(
		&got.tasks, &got.events, &got.executions, &got.outbox, &got.tombstones)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func countAll(t *testing.T, ctx context.Context, pool *pgxpool.Pool) taskFacts {
	t.Helper()
	var got taskFacts
	err := pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM tasks),
			(SELECT COUNT(*) FROM task_events),
			(SELECT COUNT(*) FROM executions),
			(SELECT COUNT(*) FROM dispatch_outbox),
			(SELECT COUNT(*) FROM request_tombstones)`).Scan(
		&got.tasks, &got.events, &got.executions, &got.outbox, &got.tombstones)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func assertAcceptedShape(t *testing.T, ctx context.Context, pool *pgxpool.Pool, employeeID string, rec task.Record) {
	t.Helper()
	var requestedNode, requestedAgent, requestedTimeout bool
	var action string
	var leaseOpen, deadlineMatches, executionIdle bool
	var kind string
	err := pool.QueryRow(ctx, `
		SELECT t.requested_target_node_id IS NULL,
		       t.requested_agent_type IS NULL,
		       t.requested_queue_timeout_seconds IS NULL,
		       o.action,
		       o.lease_until IS NULL,
		       o.send_deadline = t.queue_expires_at,
		       e.storage_generation IS NULL AND e.prepared_at IS NULL AND e.start_authorized_at IS NULL,
		       ev.kind
		FROM tasks t
		JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
		JOIN dispatch_outbox o ON o.task_id = t.id AND o.employee_id = t.employee_id
		JOIN task_events ev ON ev.task_id = t.id AND ev.employee_id = t.employee_id
		JOIN request_tombstones tb ON tb.employee_id = t.employee_id AND tb.request_id = t.request_id AND tb.task_id = t.id
		WHERE t.id = $1::uuid AND t.employee_id = $2::uuid AND t.status = 'queued' AND t.version = 1`,
		rec.TaskID, employeeID).Scan(&requestedNode, &requestedAgent, &requestedTimeout, &action, &leaseOpen, &deadlineMatches, &executionIdle, &kind)
	if err != nil {
		t.Fatal(err)
	}
	if !requestedNode || !requestedAgent || !requestedTimeout || action != task.ActionPrepare || !leaseOpen || !deadlineMatches || !executionIdle || kind != task.EventAccepted {
		t.Fatalf("接受记录不完整: node %v agent %v action %s lease %v deadline %v idle %v kind %s",
			requestedNode, requestedAgent, action, leaseOpen, deadlineMatches, executionIdle, kind)
	}
	if countFor(t, ctx, pool, employeeID) != (taskFacts{1, 1, 1, 1, 1}) {
		t.Fatal("接受事务没有恰好各写一行")
	}
}

func executionID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM executions WHERE task_id = $1::uuid`, taskID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func targetOf(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `SELECT target_node_id::text FROM tasks WHERE id = $1::uuid`, taskID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func assertConflict(t *testing.T, err error, taskID string) {
	t.Helper()
	var rej *task.Rejection
	if !errors.As(err, &rej) || rej.Code != task.CodeConflict || (taskID != "" && rej.TaskID != taskID) || rej.TaskID == "" {
		t.Fatalf("冲突结果不正确: %v", err)
	}
}

func assertCheckViolation(t *testing.T, err error, constraint string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" || pgErr.ConstraintName != constraint {
		t.Fatalf("期望约束 %s 拒绝，得到 %v", constraint, err)
	}
}

func assertCode(t *testing.T, err error, code, field string) {
	t.Helper()
	var rej *task.Rejection
	if !errors.As(err, &rej) || rej.Code != code {
		t.Fatalf("期望 %s，得到 %v", code, err)
	}
	if field != "" && (len(rej.Fields) != 1 || rej.Fields[0] != field) {
		t.Fatalf("期望字段 %s，得到 %v", field, rej.Fields)
	}
}

func assertTaskSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	var version int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = '0005_tasks.sql'`).Scan(&version); err != nil || version != 1 {
		t.Fatalf("缺少 0005_tasks.sql: %v %d", err, version)
	}
	var extra int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name IN ('sessions', 'task_relations')`).Scan(&extra); err != nil || extra != 0 {
		t.Fatalf("不应该创建 sessions 或 task_relations: %v %d", err, extra)
	}
	var column int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'nodes' AND column_name = 'default_agent_type'`).Scan(&column); err != nil || column != 1 {
		t.Fatal("nodes.default_agent_type 不存在")
	}
}

func setDefaultAgent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, nodeID, agent string) {
	t.Helper()
	tag, err := pool.Exec(ctx, `UPDATE nodes SET default_agent_type = $2 WHERE id = $1::uuid`, nodeID, agent)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("设置默认 Agent 失败: %v", err)
	}
}

func strPtr(s string) *string { return &s }

func intPtr(n int) *int { return &n }

package store_test

import (
	"errors"
	"sync"
	"testing"

	"baton/internal/node"
	"baton/internal/store"
	"baton/internal/task"
)

func TestDelegationSourceIsolationAndReplay(t *testing.T) {
	ctx, repo, pool, in, ident := preparedStart(t)
	source := store.AgentSource{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, SessionID: in.SessionID, ExecutionID: in.ExecutionID}
	input := task.Input{RequestID: "delegated", Description: "受限委托"}
	if _, err := repo.AcceptDelegation(ctx, source, input); err == nil {
		t.Fatal("尚未运行的来源能够新建委托")
	}
	if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
		t.Fatalf("启动授权: %v %+v", err, d)
	}
	if ok, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ok {
		t.Fatalf("启动事实: %v %s", err, code)
	}
	scope := "只读"
	if _, err := pool.Exec(ctx, `UPDATE tasks SET authorization_scope = $1 WHERE id = $2::uuid`, scope, in.TaskID); err != nil {
		t.Fatal(err)
	}
	target := mustRegister(t, ctx, pool, repo, in.EmployeeID, "Target", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, target.NodeID, "pi")
	if _, err := repo.SetDefaultPC(ctx, in.EmployeeID, target.NodeID); err != nil {
		t.Fatal(err)
	}
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	bobNode := mustRegister(t, ctx, pool, repo, bob.ID, "Bob", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, bobNode.NodeID, "pi")
	bobTask, err := repo.AcceptTask(ctx, bob.ID, task.Input{RequestID: "bob-task", Description: "隔离任务"})
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := repo.AcceptTask(ctx, in.EmployeeID, task.Input{RequestID: "unrelated", Description: "同员工无关任务"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{bobTask.TaskID, unrelated.TaskID, "bad-id"} {
		if _, err := repo.AgentTask(ctx, source, id); err == nil {
			t.Fatal("读取了上下文外任务")
		}
		if _, err := repo.AgentRelations(ctx, source, id); err == nil {
			t.Fatal("读取了上下文外关系")
		}
	}
	for _, invalid := range []task.Input{
		{RequestID: "forged-source", Description: "伪造", SourceSessionID: &bobTask.TaskID},
		{RequestID: "forged-parent", Description: "伪造", ParentTaskID: &unrelated.TaskID},
		{RequestID: "cross-node", Description: "越权", TargetNodeID: &bobNode.NodeID},
		{RequestID: "widened", Description: "扩大授权", AuthorizationScope: strptr("写入")},
	} {
		if _, err := repo.AcceptDelegation(ctx, source, invalid); err == nil {
			t.Fatal("接受了越权委托")
		}
	}
	// 同一来源的并发重试仍只有一个任务、执行和关系。
	const concurrency = 8
	results := make(chan task.Record, concurrency)
	errs := make(chan error, concurrency)
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec, err := repo.AcceptDelegation(ctx, source, input)
			results <- rec
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var child task.Record
	for rec := range results {
		if child.TaskID != "" && child.TaskID != rec.TaskID {
			t.Fatal("重试产生了多任务")
		}
		child = rec
	}
	if child.AuthorizationScope == nil || *child.AuthorizationScope != scope || child.TargetNodeID != target.NodeID {
		t.Fatalf("继承授权或默认目标错误: %+v", child)
	}
	if _, err := repo.SetDefaultPC(ctx, in.EmployeeID, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	replay, err := repo.AcceptDelegation(ctx, source, input)
	if err != nil || replay.TaskID != child.TaskID || replay.TargetNodeID != target.NodeID {
		t.Fatalf("默认值改变导致改派: %+v %v", replay, err)
	}
	input.Description = "不同内容"
	_, err = repo.AcceptDelegation(ctx, source, input)
	var rejection *task.Rejection
	if !errors.As(err, &rejection) || rejection.Code != task.CodeConflict {
		t.Fatalf("请求冲突: %v", err)
	}
	var executions, relations int
	if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM executions WHERE task_id = $1::uuid), (SELECT COUNT(*) FROM task_relations WHERE task_id = $1::uuid)`, child.TaskID).Scan(&executions, &relations); err != nil || executions != 1 || relations != 1 {
		t.Fatalf("重复持久化: %d %d %v", executions, relations, err)
	}
	if _, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID); err != nil {
		t.Fatal(err)
	}
	input.RequestID, input.Description = "after-cancel", "不允许新委托"
	if _, err := repo.AcceptDelegation(ctx, source, input); err == nil {
		t.Fatal("取消后的来源新建了委托")
	}
	input.RequestID, input.Description = "delegated", "受限委托"
	if rec, err := repo.AcceptDelegation(ctx, source, input); err != nil || rec.TaskID != child.TaskID {
		t.Fatalf("取消来源破坏了已接受请求的查询: %+v %v", rec, err)
	}
	if _, err := repo.AgentTask(ctx, source, child.TaskID); err != nil {
		t.Fatal(err)
	}
}

func strptr(value string) *string { return &value }

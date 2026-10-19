package store_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func TestTaskViewsFilterBeforeLimitAndRecoverOldRequest(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	n := mustRegister(t, ctx, pool, repo, alice.ID, "Node", node.RolePC, []string{"pi", "start"})
	setDefaultAgent(t, ctx, pool, n.NodeID, "pi")
	original, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: "old-request", Description: "原任务"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 103; i++ {
		rec, err := repo.AcceptTask(ctx, alice.ID, task.Input{RequestID: fmt.Sprintf("shell-%d", i), Description: "命令"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE tasks SET agent_type='shell' WHERE id=$1::uuid`, rec.TaskID); err != nil {
			t.Fatal(err)
		}
	}
	page, err := repo.ListTaskViews(ctx, alice.ID, store.TaskFilter{})
	if err != nil || len(page.Tasks) != 1 || page.Tasks[0].TaskID != original.TaskID || page.NextCursor != "" {
		t.Fatalf("筛选没有先于分页: %+v %v", page, err)
	}
	if page.Tasks[0].Status != task.StatusQueued || page.Tasks[0].DeliveryStatus != "not_ready" || page.Tasks[0].UpdatedAt.IsZero() {
		t.Fatalf("接受被误认成启动或交付: %+v", page.Tasks[0])
	}
	page, err = repo.ListTaskViews(ctx, alice.ID, store.TaskFilter{IncludeShell: true})
	if err != nil || len(page.Tasks) != 100 || page.NextCursor == "" {
		t.Fatalf("首批: %d %v", len(page.Tasks), err)
	}
	seen := map[string]bool{}
	for _, rec := range page.Tasks {
		seen[rec.TaskID] = true
	}
	next, err := repo.ListTaskViews(ctx, alice.ID, store.TaskFilter{IncludeShell: true, Cursor: page.NextCursor})
	if err != nil || len(next.Tasks) != 4 || next.NextCursor != "" {
		t.Fatalf("第二批: %+v %v", next, err)
	}
	for _, rec := range next.Tasks {
		if seen[rec.TaskID] {
			t.Fatal("分页重复")
		}
	}
	for _, employee := range []string{alice.ID, bob.ID} {
		recovered, err := repo.ListTaskViews(ctx, employee, store.TaskFilter{RequestID: "old-request"})
		if err != nil {
			t.Fatal(err)
		}
		if employee == alice.ID && (len(recovered.Tasks) != 1 || recovered.Tasks[0].TaskID != original.TaskID) {
			t.Fatal("旧请求不能恢复")
		}
		if employee == bob.ID && len(recovered.Tasks) != 0 {
			t.Fatal("请求查询泄露其他员工任务")
		}
	}
	for _, filter := range []store.TaskFilter{{Cursor: original.TaskID}, {ParentTaskID: original.TaskID}} {
		if _, err := repo.ListTaskViews(ctx, bob.ID, filter); !errors.Is(err, store.ErrNotVisible) {
			t.Fatalf("越权查询: %v", err)
		}
	}
	if _, err := repo.GetTaskView(ctx, bob.ID, original.TaskID); !errors.Is(err, store.ErrNotVisible) {
		t.Fatalf("越权详情: %v", err)
	}
	if countFor(t, ctx, pool, alice.ID).tasks != 104 {
		t.Fatal("只读查询新增执行")
	}
}

func TestTaskViewDeliveryDoesNotChangeExecution(t *testing.T) {
	ctx, repo, _, in, ident := preparedStart(t)
	if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
		t.Fatal(err)
	}
	if ok, _, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ok {
		t.Fatal(err)
	}
	source := store.AgentSource{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID}
	child, err := repo.AcceptDelegation(ctx, source, task.Input{RequestID: "child", Description: "子委托", TargetNodeID: &ident.NodeID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RequestCancel(ctx, in.EmployeeID, child.TaskID); err != nil {
		t.Fatal(err)
	}
	before, err := repo.GetTaskView(ctx, in.EmployeeID, child.TaskID)
	if err != nil || before.DeliveryStatus != "pending" {
		t.Fatalf("等待交付: %+v %v", before, err)
	}
	deliveries, err := repo.ChildDeliveries(ctx, source, "")
	if err != nil || len(deliveries) != 1 {
		t.Fatal(err)
	}
	for _, state := range []string{"available", "source_stopped", "uncertain"} {
		generation := 0
		if state == "uncertain" {
			generation = 2
		}
		if err := repo.RecordChildReceipt(ctx, source, protocol.ChildReceipt{DeliveryID: deliveries[0].DeliveryID, Status: state, Generation: generation}); err != nil {
			t.Fatal(err)
		}
		view, err := repo.GetTaskView(ctx, in.EmployeeID, child.TaskID)
		if err != nil || view.Status != task.StatusCancelled || view.DeliveryStatus != state || view.DeliveryUpdatedAt == nil {
			t.Fatalf("执行与交付: %+v %v", view, err)
		}
	}
	page, err := repo.ListTaskViews(ctx, in.EmployeeID, store.TaskFilter{ParentTaskID: in.TaskID})
	if err != nil || len(page.Tasks) != 1 || page.Tasks[0].TaskID != child.TaskID {
		t.Fatalf("委托关系: %+v %v", page, err)
	}
}

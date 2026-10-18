package store_test

import (
	"context"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func TestChildDeliveryGatesCompletionAndBindsGeneration(t *testing.T) {
	for _, state := range []string{"delivered", "uncertain"} {
		t.Run(state, func(t *testing.T) {
			ctx, repo, pool, in, ident := preparedStart(t)
			if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
				t.Fatalf("授权: %+v %v", d, err)
			}
			if ok, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ok {
				t.Fatalf("启动: %s %v", code, err)
			}
			source := store.AgentSource{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID}
			child, err := repo.AcceptDelegation(ctx, source, task.Input{RequestID: "child", Description: "子委托", TargetNodeID: &ident.NodeID})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := repo.RequestCancel(ctx, in.EmployeeID, child.TaskID); err != nil {
				t.Fatal(err)
			}
			report := completedReport(in, mustUUID(t))
			if ok, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || ok || code != "delegation_pending" {
				t.Fatalf("未处理的已结束子委托未阻止完成: %v %s %v", ok, code, err)
			}
			deliveries, err := repo.ChildDeliveries(ctx, source, "")
			if err != nil || len(deliveries) != 1 {
				t.Fatalf("通知: %+v %v", deliveries, err)
			}
			again, err := repo.ChildDeliveries(ctx, source, "")
			if err != nil || len(again) != 1 || again[0].DeliveryID != deliveries[0].DeliveryID {
				t.Fatalf("不稳定的 delivery_id: %+v %v", again, err)
			}
			bad := source
			bad.NodeID = mustUUID(t)
			if _, err := repo.ChildDeliveries(ctx, bad, ""); err == nil {
				t.Fatal("伪造来源收到通知")
			}
			r := protocol.ChildReceipt{DeliveryID: deliveries[0].DeliveryID, Status: state, Generation: 2}
			if err := repo.RecordChildReceipt(ctx, bad, r); err == nil {
				t.Fatal("伪造来源确认交付")
			}
			if err := repo.RecordChildReceipt(ctx, source, r); err != nil {
				t.Fatal(err)
			}
			if err := repo.RecordChildReceipt(ctx, source, r); err != nil {
				t.Fatal("重复确认", err)
			}
			view, err := repo.AgentTaskView(ctx, source, child.TaskID)
			if err != nil || view.Status != task.StatusCancelled || view.DeliveryStatus != state {
				t.Fatalf("混淆执行结果与交付状态: %+v %v", view, err)
			}
			if ok, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || ok || code != task.CodeConflict {
				t.Fatalf("接受旧候选: %v %s %v", ok, code, err)
			}
			report.InputGeneration = 2
			ok, code, err := repo.ApplyExecutionReport(ctx, report)
			if err != nil || ok != (state == "delivered") || (!ok && code != "delegation_pending") {
				t.Fatalf("新代次门禁: %v %s %v", ok, code, err)
			}
			var generation int
			if err := pool.QueryRow(ctx, `SELECT input_generation FROM executions WHERE id = $1::uuid`, in.ExecutionID).Scan(&generation); err != nil || generation != 2 {
				t.Fatalf("代次: %d %v", generation, err)
			}
		})
	}
}

func TestParentCancelTracksDescendantsIndependently(t *testing.T) {
	ctx, repo, pool, in, ident := preparedStart(t)
	if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
		t.Fatalf("授权: %+v %v", d, err)
	}
	if ok, _, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ok {
		t.Fatal(err)
	}
	source := store.AgentSource{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID}
	child, err := repo.AcceptDelegation(ctx, source, task.Input{RequestID: "running-child", Description: "正在运行", TargetNodeID: &ident.NodeID})
	if err != nil {
		t.Fatal(err)
	}
	var childExec string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM executions WHERE task_id = $1::uuid`, child.TaskID).Scan(&childExec); err != nil {
		t.Fatal(err)
	}
	// 运行事实由另一个执行身份持有，父回执不能代替它。
	if _, err := pool.Exec(ctx, `UPDATE executions SET start_authorized_at = now(), started_at = now() WHERE id = $1::uuid`, childExec); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET status = 'running' WHERE id = $1::uuid`, child.TaskID); err != nil {
		t.Fatal(err)
	}
	grandchild, err := repo.AcceptTask(ctx, in.EmployeeID, task.Input{RequestID: "queued-grandchild", Description: "尚未执行", ParentTaskID: &child.TaskID, TargetNodeID: &ident.NodeID})
	if err != nil {
		t.Fatal(err)
	}
	ended, err := repo.AcceptDelegation(ctx, source, task.Input{RequestID: "failed-middle", Description: "已结束中间任务", TargetNodeID: &ident.NodeID})
	if err != nil {
		t.Fatal(err)
	}
	orphan, err := repo.AcceptTask(ctx, in.EmployeeID, task.Input{RequestID: "queued-descendant", Description: "未结束后代", ParentTaskID: &ended.TaskID, TargetNodeID: &ident.NodeID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET status = 'failed' WHERE id = $1::uuid`, ended.TaskID); err != nil {
		t.Fatal(err)
	}
	decision, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
	if err != nil || len(decision.Children) != 2 || len(decision.Children[0].Children) != 1 || len(decision.Children[1].Children) != 1 {
		t.Fatalf("级联: %+v %v", decision, err)
	}
	parentStop := store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, EventID: mustUUID(t), TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID,
		Kind: task.EventStopReport, Status: task.StatusNeedsVerification, StopReason: task.StatusCancelled, AgentStopped: true, OutcomeKnown: true, OccurredAt: time.Now()}
	if ok, code, err := repo.ApplyExecutionReport(ctx, parentStop); err != nil || !ok {
		t.Fatalf("父停止: %s %v", code, err)
	}
	var parentStatus, childStatus, grandStatus string
	var stopped bool
	if err := pool.QueryRow(ctx, `SELECT p.status, c.status, g.status, x.stopped_at IS NOT NULL FROM tasks p, tasks c, tasks g, execution_stops x
      WHERE p.id = $1::uuid AND c.id = $2::uuid AND g.id = $3::uuid AND x.execution_id = $4::uuid`, in.TaskID, child.TaskID, grandchild.TaskID, childExec).Scan(&parentStatus, &childStatus, &grandStatus, &stopped); err != nil {
		t.Fatal(err)
	}
	if parentStatus != task.StatusCancelled || childStatus != task.StatusNeedsVerification || grandStatus != task.StatusCancelled || stopped {
		t.Fatalf("错误地把父停止当成子停止: %s %s %s %v", parentStatus, childStatus, grandStatus, stopped)
	}
	var endedStatus, orphanStatus string
	if err := pool.QueryRow(ctx, `SELECT a.status, b.status FROM tasks a, tasks b WHERE a.id = $1::uuid AND b.id = $2::uuid`, ended.TaskID, orphan.TaskID).Scan(&endedStatus, &orphanStatus); err != nil {
		t.Fatal(err)
	}
	if endedStatus != task.StatusFailed || orphanStatus != task.StatusCancelled {
		t.Fatalf("已结束中间任务漏取消后代: %s %s", endedStatus, orphanStatus)
	}
	if _, err := repo.RequestCancel(context.Background(), in.EmployeeID, in.TaskID); err != nil {
		t.Fatal("重复取消", err)
	}
}

func TestPendingChildDeliveryIsNotStarvedBySavedResults(t *testing.T) {
	ctx, repo, _, in, ident := preparedStart(t)
	if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
		t.Fatalf("授权: %+v %v", d, err)
	}
	if ok, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ok {
		t.Fatalf("启动: %s %v", code, err)
	}
	source := store.AgentSource{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID}
	for _, state := range []string{"available", "source_stopped", "available"} {
		child, err := repo.AcceptDelegation(ctx, source, task.Input{RequestID: mustUUID(t), Description: "新的子结果", TargetNodeID: &ident.NodeID})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RequestCancel(ctx, in.EmployeeID, child.TaskID); err != nil {
			t.Fatal(err)
		}
		deliveries, err := repo.ChildDeliveries(ctx, source, "")
		if err != nil || len(deliveries) != 1 || deliveries[0].ChildTaskID != child.TaskID {
			t.Fatalf("已保存交付饿死新通知: %+v %v", deliveries, err)
		}
		receipt := protocol.ChildReceipt{DeliveryID: deliveries[0].DeliveryID, Status: state}
		if err := repo.RecordChildReceipt(ctx, source, receipt); err != nil {
			t.Fatal(err)
		}
	}
}

package store_test

import (
	"strings"
	"testing"
	"time"

	"baton/internal/store"
	"baton/internal/task"
)

func TestCancelStopFactsAndIdempotency(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		stopped, known, notStarted bool
		status                     string
	}{
		{"未发送输入", true, true, true, task.StatusCancelled},
		{"确认停止及操作结果", true, true, false, task.StatusCancelled},
		{"接口返回但未停止", false, false, false, task.StatusNeedsVerification},
		{"停止但结果未知", true, false, false, task.StatusNeedsVerification},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, repo, pool, in, _ := preparedStart(t)
			if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
				t.Fatalf("授权: %+v %v", d, err)
			}
			if d, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID); err != nil || d.Status != task.StatusNeedsVerification {
				t.Fatalf("请求被误当成确认: %+v %v", d, err)
			}
			before, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil || before.CancelRequestedAt == nil || before.StopRequestedAt == nil || before.StopConfirmedAt != nil {
				t.Fatalf("请求证据: %+v %v", before, err)
			}
			report := store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID,
				EventID: mustUUID(t), Kind: task.EventStopReport, Status: task.StatusNeedsVerification, StopReason: task.StatusCancelled,
				OccurredAt: time.Now().UTC(), AgentStopped: tc.stopped, OutcomeKnown: tc.known, NotStarted: tc.notStarted, WorkerSequence: 1}
			for i := 0; i < 2; i++ {
				if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack || code != "" {
					t.Fatalf("确认: %v %s %v", ack, code, err)
				}
			}
			after, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil || after.Status != tc.status || after.StopAcknowledgedAt == nil || (after.StopConfirmedAt != nil) != tc.stopped || after.StopOutcomeKnown != tc.known || after.Version != before.Version+1 {
				t.Fatalf("停止事实: %+v %v", after, err)
			}
			if after.Summary == nil || !strings.Contains(*after.Summary, "不") || !strings.Contains(*after.Summary, "回滚") {
				t.Fatal("缺少外部副作用边界")
			}
			var bound *string
			if err := pool.QueryRow(ctx, `SELECT bound_execution_id::text FROM sessions WHERE id = $1::uuid`, in.SessionID).Scan(&bound); err != nil {
				t.Fatal(err)
			}
			if (bound == nil) != (tc.stopped && tc.known) {
				t.Fatalf("不确定执行被释放: %v", bound)
			}
			if _, code, err := repo.LoadTaskInput(ctx, in.EmployeeID, in.NodeID, in.TaskID, in.ExecutionID, in.SessionID); err != nil || code == "" {
				t.Fatalf("取消后还可补发: %s %v", code, err)
			}
			if d, err := repo.AuthorizeStart(ctx, in); err != nil || d.Issue {
				t.Fatalf("停止后再授权: %+v %v", d, err)
			}
			evs, err := repo.ListTaskEvents(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			ev := evs[len(evs)-1]
			if ev.Kind != task.EventStopReport || ev.WorkerSequence != 1 || ev.OccurredAt == nil || ev.NotStarted == nil || *ev.NotStarted != tc.notStarted || ev.StopReason == nil {
				t.Fatalf("事实未展示: %+v", ev)
			}
		})
	}
}

func TestExecutionDeadlineUsesCenterClockAndNeverReplays(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	report := startedReport(in, mustUUID(t))
	report.OccurredAt = time.Now().Add(24 * time.Hour)
	if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack {
		t.Fatalf("启动: %s %v", code, err)
	}
	before, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || before.ExecutionExpiresAt == nil || before.ExecutionExpiresAt.After(time.Now().Add(3*time.Hour)) {
		t.Fatalf("中心期限依赖 Worker 墙钟: %+v %v", before, err)
	}
	expiry := *before.ExecutionExpiresAt
	if err := repo.ExpireExecutionsAt(ctx, expiry.Add(-time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	if r, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID); err != nil || r.Status != task.StatusRunning {
		t.Fatalf("提前到期: %+v %v", r, err)
	}
	for i := 0; i < 2; i++ {
		if err := repo.ExpireExecutionsAt(ctx, expiry); err != nil {
			t.Fatal(err)
		}
	}
	r, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || r.Status != task.StatusNeedsVerification || r.StopReason == nil || *r.StopReason != task.CodeExecutionTimeout || r.StopConfirmedAt != nil || r.Version != before.Version+1 {
		t.Fatalf("到期误宣称已停止: %+v %v", r, err)
	}
	if _, code, err := repo.LoadTaskInput(ctx, in.EmployeeID, in.NodeID, in.TaskID, in.ExecutionID, in.SessionID); err != nil || code == "" {
		t.Fatalf("到期仍能补发: %s %v", code, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM execution_stops WHERE execution_id = $1::uuid`, in.ExecutionID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("中止命令不幂等: %d %v", count, err)
	}
}

func TestCompletionCancelOrderingRetainsFacts(t *testing.T) {
	for _, stopFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "先完成", true: "先确认取消"}[stopFirst], func(t *testing.T) {
			ctx, repo, _, in, _ := preparedStart(t)
			if _, err := repo.AuthorizeStart(ctx, in); err != nil {
				t.Fatal(err)
			}
			result := completedReport(in, mustUUID(t))
			result.OccurredAt = time.Now().Add(-time.Second)
			result.WorkerSequence = 1
			stop := store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID,
				EventID: mustUUID(t), Kind: task.EventStopReport, Status: task.StatusNeedsVerification, StopReason: task.StatusCancelled,
				OccurredAt: time.Now().UTC(), AgentStopped: true, OutcomeKnown: true, WorkerSequence: 2}
			apply := func(report store.ExecutionReport) {
				t.Helper()
				if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack {
					t.Fatalf("上报: %s %v", code, err)
				}
			}
			if !stopFirst {
				apply(result)
			}
			if _, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID); err != nil {
				t.Fatal(err)
			}
			apply(stop)
			if stopFirst {
				apply(result)
			}
			r, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			want := task.StatusCompleted
			if stopFirst {
				want = task.StatusCancelled
			}
			if r.Status != want {
				t.Fatalf("终态被后到事实改写: %s", r.Status)
			}
			events, err := repo.ListTaskEvents(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			var sawResult, sawStop bool
			for _, ev := range events {
				if ev.Kind == task.EventResult {
					sawResult = ev.Status == task.StatusCompleted && ev.WorkerSequence == 1 && ev.OccurredAt != nil
				}
				if ev.Kind == task.EventStopReport {
					sawStop = ev.WorkerSequence == 2 && ev.OccurredAt != nil
				}
			}
			if !sawResult || !sawStop || r.CancelRequestedAt == nil {
				t.Fatalf("竞态先后证据丢失: %+v", events)
			}
		})
	}
}

func TestQueueExpiryWithoutPreparationCannotStart(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := pool.Exec(ctx, `UPDATE executions SET prepared_at = NULL WHERE id = $1::uuid`, in.ExecutionID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET created_at = now() - interval '1 hour', queue_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, in.TaskID); err != nil {
		t.Fatal(err)
	}
	if err := repo.ExpireQueuedTasks(ctx); err != nil {
		t.Fatal(err)
	}
	r, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || r.Status != task.StatusFailed || r.ErrorCode == nil || *r.ErrorCode != task.CodeQueueTimeout {
		t.Fatalf("未准备任务永远排队: %+v %v", r, err)
	}
	if d, err := repo.AuthorizeStart(ctx, in); err != nil || d.Issue || d.PossibleStart {
		t.Fatalf("到期后再启动: %+v %v", d, err)
	}
}

func TestDelayedStartProofSupersedesQueueTimeoutRequest(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET created_at = now() - interval '1 hour', queue_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, in.TaskID); err != nil {
		t.Fatal(err)
	}
	if err := repo.ExpireQueuedTasks(ctx); err != nil {
		t.Fatal(err)
	}
	report := startedReport(in, mustUUID(t))
	report.QueueDeadlineMet = true
	if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack {
		t.Fatalf("延迟启动事实: %s %v", code, err)
	}
	view, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || view.Status != task.StatusRunning || view.StopRequestedAt != nil {
		t.Fatalf("排队到期被当成已经执行任务的失败依据: %+v %v", view, err)
	}
}

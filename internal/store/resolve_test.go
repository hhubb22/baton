package store_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"baton/internal/store"
	"baton/internal/task"
)

func resolutionInput(version int, status string) task.ResolveInput {
	return task.ResolveInput{ExpectedVersion: version, Status: status, Summary: "现场核实后的结论", Reason: "员工检查设备及节点记录",
		Evidence: []task.ResultRef{{StorageRef: "inspection", ResourceID: "signed-note", AccessStatus: task.AccessAvailable}}}
}

func TestResolvePreservesPreviousConclusionAndLateEvidence(t *testing.T) {
	for _, status := range []string{task.StatusCompleted, task.StatusFailed, task.StatusCancelled} {
		t.Run(status, func(t *testing.T) {
			ctx, repo, pool, in, _ := preparedStart(t)
			if _, err := repo.AuthorizeStart(ctx, in); err != nil {
				t.Fatal(err)
			}
			report := completedReport(in, mustUUID(t))
			report.Status, report.ErrorCode, report.ErrorMessage = task.StatusFailed, task.CodeExecutionFailed, "原执行失败"
			if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack {
				t.Fatalf("原结果: %s %v", code, err)
			}
			previous, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			request := resolutionInput(previous.Version, status)
			resolved, err := repo.ResolveTask(ctx, in.EmployeeID, in.TaskID, request)
			if err != nil || resolved.Status != status || resolved.Version != previous.Version+1 || resolved.Summary == nil || *resolved.Summary != request.Summary || len(resolved.Evidence) != 1 || resolved.Evidence[0].ResourceID != "signed-note" {
				t.Fatalf("核实结果: %+v %v", resolved, err)
			}
			late := completedReport(in, mustUUID(t))
			for i := 0; i < 2; i++ {
				if ack, code, err := repo.ApplyExecutionReport(ctx, late); err != nil || !ack {
					t.Fatalf("迟到结果: %s %v", code, err)
				}
			}
			uncertain := store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID,
				ExecutionID: in.ExecutionID, SessionID: in.SessionID, EventID: mustUUID(t), Kind: task.EventNeedsVerification,
				Status: task.StatusNeedsVerification, ErrorCode: task.CodeUncertainWorker}
			if ack, code, err := repo.ApplyExecutionReport(ctx, uncertain); err != nil || !ack {
				t.Fatalf("迟到不确定报告: %s %v", code, err)
			}
			stop := store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID,
				ExecutionID: in.ExecutionID, SessionID: in.SessionID, EventID: mustUUID(t), Kind: task.EventStopReport,
				Status: task.StatusNeedsVerification, StopReason: task.StatusCancelled,
				AgentStopped: true, OutcomeKnown: true, OccurredAt: time.Now(), WorkerSequence: 2}
			if ack, code, err := repo.ApplyExecutionReport(ctx, stop); err != nil || !ack {
				t.Fatalf("迟到中止报告: %s %v", code, err)
			}
			current, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil || current.Status != status || *current.Summary != request.Summary || current.Version != resolved.Version+3 || len(current.Evidence) != 2 {
				t.Fatalf("迟到消息改写人工结论: %+v %v", current, err)
			}
			events, err := repo.ListTaskEvents(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			var manual, lateResults int
			for _, event := range events {
				if event.Kind == task.EventResult {
					lateResults++
				}
				if event.Kind != task.EventResolved {
					continue
				}
				manual++
				audit := event.Resolution
				if audit == nil || event.ActorEmployeeID != in.EmployeeID || event.ExecutionID == nil || *event.ExecutionID != in.ExecutionID || audit.Reason != request.Reason || audit.Previous.Status != task.StatusFailed || audit.Previous.ErrorMessage == nil || *audit.Previous.ErrorMessage != "原执行失败" || len(audit.Previous.Evidence) != 1 || audit.Previous.Evidence[0].ResourceID != "count-1" {
					t.Fatalf("核实审计丢失: %+v", event)
				}
			}
			if manual != 1 || lateResults != 2 {
				t.Fatalf("事件重复或缺失: %+v", events)
			}
			var executions, outbox int
			if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM executions), (SELECT COUNT(*) FROM dispatch_outbox)`).Scan(&executions, &outbox); err != nil || executions != 1 || outbox != 1 {
				t.Fatalf("核实重新执行: %d %d %v", executions, outbox, err)
			}
			_, err = repo.ResolveTask(ctx, in.EmployeeID, in.TaskID, request)
			var rejection *task.Rejection
			if !errors.As(err, &rejection) || rejection.Code != task.CodeConflict || rejection.CurrentVersion != current.Version || rejection.CurrentStatus != status {
				t.Fatalf("未返回最新版本: %+v %v", rejection, err)
			}
		})
	}
}

func TestResolveAndRerunRollbackAllWrites(t *testing.T) {
	for _, action := range []string{"resolve", "rerun"} {
		t.Run(action, func(t *testing.T) {
			ctx, repo, pool, in, _ := preparedStart(t)
			if _, err := repo.AuthorizeStart(ctx, in); err != nil {
				t.Fatal(err)
			}
			if ack, _, err := repo.ApplyExecutionReport(ctx, completedReport(in, mustUUID(t))); err != nil || !ack {
				t.Fatalf("原结论: %v", err)
			}
			before, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			eventsBefore, err := repo.ListTaskEvents(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			repo.SetTaskCommitHook(func(context.Context) error { return errors.New("injected commit failure") })
			if action == "resolve" {
				_, err = repo.ResolveTask(ctx, in.EmployeeID, in.TaskID, resolutionInput(before.Version, task.StatusCompleted))
			} else {
				_, err = repo.RerunTask(ctx, in.EmployeeID, in.TaskID, task.RerunInput{RequestID: "rollback-rerun", ExpectedVersion: before.Version, Reason: "重新调查"})
			}
			if err == nil {
				t.Fatal("提交失败仍返回成功")
			}
			after, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil || !reflect.DeepEqual(after, before) {
				t.Fatalf("任务未回滚: %+v %v", after, err)
			}
			var tasks, execs, outbox, tombstones, events, relations int
			if err := pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM tasks), (SELECT COUNT(*) FROM executions),
			 (SELECT COUNT(*) FROM dispatch_outbox), (SELECT COUNT(*) FROM request_tombstones), (SELECT COUNT(*) FROM task_events), (SELECT COUNT(*) FROM task_relations)`).Scan(&tasks, &execs, &outbox, &tombstones, &events, &relations); err != nil || tasks != 1 || execs != 1 || outbox != 1 || tombstones != 1 || relations != 1 || events != len(eventsBefore) {
				t.Fatalf("事务残留: %d %d %d %d %d %d %v", tasks, execs, outbox, tombstones, events, relations, err)
			}
			repo.SetTaskCommitHook(nil)
		})
	}
}

func TestConcurrentManualActionsHaveOneVersionWinner(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		t.Run(map[bool]string{false: "two-resolutions", true: "resolve-rerun"}[mixed], func(t *testing.T) {
			ctx, repo, _, in, _ := preparedStart(t)
			if _, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID); err != nil {
				t.Fatal(err)
			}
			before, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			var wg sync.WaitGroup
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					var err error
					if mixed && i == 1 {
						_, err = repo.RerunTask(ctx, in.EmployeeID, in.TaskID, task.RerunInput{RequestID: "race", ExpectedVersion: before.Version, Reason: "重新执行"})
					} else {
						_, err = repo.ResolveTask(ctx, in.EmployeeID, in.TaskID, resolutionInput(before.Version, task.StatusCompleted))
					}
					results <- err
				}(i)
			}
			close(start)
			wg.Wait()
			close(results)
			successes, conflicts := 0, 0
			for err := range results {
				if err == nil {
					successes++
					continue
				}
				var rej *task.Rejection
				if !errors.As(err, &rej) || rej.Code != task.CodeConflict || rej.CurrentVersion != before.Version+1 {
					t.Fatalf("意外并发失败: %v", err)
				}
				conflicts++
			}
			if successes != 1 || conflicts != 1 {
				t.Fatalf("并发写入未互斥: %d %d", successes, conflicts)
			}
		})
	}
}

func TestRerunConfirmationIdempotencyAndNewIdentity(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RequestCancel(ctx, in.EmployeeID, in.TaskID); err != nil {
		t.Fatal(err)
	}
	before, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || before.Status != task.StatusNeedsVerification {
		t.Fatalf("前提: %+v %v", before, err)
	}
	input := task.RerunInput{RequestID: "explicit-rerun", ExpectedVersion: before.Version, Reason: "接受重复副作用风险，重新执行"}
	_, err = repo.RerunTask(ctx, in.EmployeeID, in.TaskID, input)
	var rej *task.Rejection
	if !errors.As(err, &rej) || rej.Code != task.CodeConflict || rej.CurrentStatus != task.StatusNeedsVerification {
		t.Fatalf("未确认仍重做: %v", err)
	}
	input.ConfirmSideEffects = true
	start := make(chan struct{})
	type outcome struct {
		rec task.Record
		err error
	}
	results := make(chan outcome, 8)
	for i := 0; i < 8; i++ {
		go func() {
			<-start
			rec, err := repo.RerunTask(ctx, in.EmployeeID, in.TaskID, input)
			results <- outcome{rec, err}
		}()
	}
	close(start)
	var next task.Record
	for i := 0; i < 8; i++ {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		if i > 0 && got.rec.TaskID != next.TaskID {
			t.Fatal("重复重做创建多个任务")
		}
		next = got.rec
	}
	if next.TaskID == before.TaskID || next.RerunOfTaskID == nil || *next.RerunOfTaskID != before.TaskID || next.TargetSessionID != nil || next.ParentTaskID != nil || next.SourceSessionID != nil || next.Description != before.Description || next.TargetNodeID != before.TargetNodeID || next.AgentType != before.AgentType {
		t.Fatalf("重做未创建独立关联任务: %+v", next)
	}
	current, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || current.Status != before.Status || current.Version != before.Version+1 || current.CancelRequestedAt == nil {
		t.Fatalf("重做覆盖原任务: %+v %v", current, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(DISTINCT id) FROM executions WHERE task_id IN ($1::uuid,$2::uuid)`, in.TaskID, next.TaskID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("复用了执行身份: %d %v", count, err)
	}
	events, err := repo.ListTaskEvents(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	last := events[len(events)-1]
	if last.Rerun == nil || last.Rerun.TaskID != next.TaskID || !last.Rerun.ConfirmSideEffects || last.Rerun.PreviousStatus != before.Status || last.ActorEmployeeID != in.EmployeeID {
		t.Fatalf("重做缺少审计: %+v", last)
	}
	input.Reason = "不同理由"
	_, err = repo.RerunTask(ctx, in.EmployeeID, in.TaskID, input)
	assertConflict(t, err, next.TaskID)
	_, err = repo.AcceptTask(ctx, in.EmployeeID, task.Input{RequestID: input.RequestID, Description: before.Description})
	assertConflict(t, err, next.TaskID)
}

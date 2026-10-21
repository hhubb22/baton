package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"baton/internal/store"
	"baton/internal/task"
)

func TestEmployeeAcceptancePreservesExecutionResult(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	if ack, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, mustUUID(t))); err != nil || !ack || code != "" {
		t.Fatalf("启动：%v %s", err, code)
	}
	report := completedReport(in, mustUUID(t))
	if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack || code != "" {
		t.Fatalf("结果：%v %s", err, code)
	}
	rec, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	inReview := task.AcceptanceInput{ExpectedVersion: rec.Version, Decision: "passed", Comment: "员工核查证据后通过"}
	repo.SetTaskCommitHook(func(context.Context) error { return errors.New("提交失败") })
	if _, err := repo.AcceptResult(ctx, in.EmployeeID, in.TaskID, inReview); err == nil {
		t.Fatal("提交失败仍验收")
	}
	repo.SetTaskCommitHook(nil)
	a, err := repo.AcceptResult(ctx, in.EmployeeID, in.TaskID, inReview)
	if err != nil || a.EmployeeID != in.EmployeeID || a.TaskVersion != rec.Version+1 || a.CreatedAt.IsZero() {
		t.Fatalf("验收：%+v %v", a, err)
	}
	if _, err := repo.AcceptResult(ctx, in.EmployeeID, in.TaskID, inReview); err == nil {
		t.Fatal("旧版本重复验收")
	}
	if ack, code, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack || code != "" {
		t.Fatalf("重复结果：%v %s", err, code)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_acceptances WHERE task_id=$1`, in.TaskID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("验收数：%d %v", count, err)
	}
	after, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil || after.Status != task.StatusCompleted || (after.Summary == nil || *after.Summary != report.Summary) {
		t.Fatalf("验收改变执行：%+v %v", after, err)
	}

	late := completedReport(in, mustUUID(t))
	if ack, code, err := repo.ApplyExecutionReport(ctx, late); err != nil || !ack || code != "" {
		t.Fatalf("迟到结果 %v %s", err, code)
	}
	after, err = repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ResolveTask(ctx, in.EmployeeID, in.TaskID, task.ResolveInput{ExpectedVersion: after.Version, Status: task.StatusCompleted, Summary: "修正核实结论", Reason: "人工重新核查", EvidenceEmptyReason: "无文件"}); err != nil {
		t.Fatal(err)
	}
	after, err = repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	var executions, dispatches int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM executions),(SELECT count(*) FROM dispatch_outbox)`).Scan(&executions, &dispatches); err != nil || executions != 1 || dispatches != 1 {
		t.Fatalf("执行 %d 投递 %d %v", executions, dispatches, err)
	}
	list, err := repo.ListAcceptances(ctx, in.EmployeeID, in.TaskID)
	if err != nil || len(list) != 1 || list[0].Comment != inReview.Comment {
		t.Fatalf("审计：%+v %v", list, err)
	}
}

func TestAcceptanceRejectsUnknownOutcomeAndSerializesReviews(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	if ack, _, err := repo.ApplyExecutionReport(ctx, store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, EventID: mustUUID(t), TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID, Kind: task.EventNeedsVerification, Status: task.StatusNeedsVerification, ErrorCode: task.CodeUncertainInput}); err != nil || !ack {
		t.Fatal(err)
	}
	rec, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	request := task.AcceptanceInput{ExpectedVersion: rec.Version, Decision: "passed", Comment: "验证"}
	if _, err := repo.AcceptResult(ctx, in.EmployeeID, in.TaskID, request); err == nil {
		t.Fatal("未知执行允许验收")
	}
	if _, err := repo.ResolveTask(ctx, in.EmployeeID, in.TaskID, task.ResolveInput{ExpectedVersion: rec.Version, Status: task.StatusCompleted, Summary: "人工核实", Reason: "查到证据", EvidenceEmptyReason: "无文件"}); err != nil {
		t.Fatal(err)
	}
	rec, err = repo.GetTask(ctx, in.EmployeeID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	request.ExpectedVersion = rec.Version
	var wg sync.WaitGroup
	var mu sync.Mutex
	passed := 0
	for range 8 {
		wg.Go(func() {
			if _, err := repo.AcceptResult(ctx, in.EmployeeID, in.TaskID, request); err == nil {
				mu.Lock()
				passed++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if passed != 1 {
		t.Fatalf("并发验收成功 %d 次", passed)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM executions`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("验收新建执行：%d %v", n, err)
	}
}

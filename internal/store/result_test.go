package store_test

import (
	"testing"

	"baton/internal/store"
	"baton/internal/task"
)

func TestExecutionReportPersistsOnceAndKeepsHistoryOut(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	decision, err := repo.AuthorizeStart(ctx, in)
	if err != nil || !decision.Issue {
		t.Fatalf("没有授权: %v %+v", err, decision)
	}
	startedID := mustUUID(t)
	ack, code, err := repo.ApplyExecutionReport(ctx, startedReport(in, startedID))
	if err != nil || !ack || code != "" {
		t.Fatalf("启动事实没有保存: %v %s", err, code)
	}
	var status string
	var generation int
	var deliveries int
	if err := pool.QueryRow(ctx, `
		SELECT t.status, e.input_generation, (SELECT COUNT(*) FROM delivery_records WHERE task_id = t.id)
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, in.TaskID).Scan(&status, &generation, &deliveries); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusRunning || generation != 1 || deliveries != 0 {
		t.Fatalf("启动后的记录不正确: %s generation %d deliveries %d", status, generation, deliveries)
	}
	resultID := mustUUID(t)
	ack, code, err = repo.ApplyExecutionReport(ctx, completedReport(in, resultID))
	if err != nil || !ack || code != "" {
		t.Fatalf("结果没有保存: %v %s", err, code)
	}
	ack, code, err = repo.ApplyExecutionReport(ctx, completedReport(in, resultID))
	if err != nil || !ack || code != "" {
		t.Fatalf("重复结果没有按原记录确认: %v %s", err, code)
	}
	var summary string
	var refs int
	if err := pool.QueryRow(ctx, `
		SELECT t.status, t.summary, (SELECT COUNT(*) FROM delivery_records WHERE task_id = t.id),
		       (SELECT COUNT(*) FROM task_result_refs WHERE task_id = t.id)
		FROM tasks t WHERE t.id = $1::uuid`, in.TaskID).Scan(&status, &summary, &deliveries, &refs); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusCompleted || summary != "计数执行器已交回结构化结果" || deliveries != 1 || refs != 1 {
		t.Fatalf("结果记录不正确: %s %q deliveries %d refs %d", status, summary, deliveries, refs)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM tasks WHERE id = $1::uuid AND (
				summary LIKE '%' || $2 || '%' OR COALESCE(error_message, '') LIKE '%' || $2 || '%'
				OR COALESCE(evidence_empty_reason, '') LIKE '%' || $2 || '%'
				OR COALESCE(artifacts_empty_reason, '') LIKE '%' || $2 || '%'))
			+ (SELECT COUNT(*) FROM task_result_refs WHERE task_id = $1::uuid AND (
				resource_id LIKE '%' || $2 || '%' OR COALESCE(note, '') LIKE '%' || $2 || '%'
				OR COALESCE(storage_ref, '') LIKE '%' || $2 || '%' OR COALESCE(node_id::text, '') = $2))
			+ (SELECT COUNT(*) FROM task_events WHERE task_id = $1::uuid AND (
				id::text = $2 OR COALESCE(reason_code, '') = $2))
		`, in.TaskID, "native-history-do-not-sync").Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("完整历史进入了中心: %v %d", err, leaked)
	}
	blocked, code, err := repo.ApplyExecutionReport(ctx, store.ExecutionReport{
		EmployeeID: in.EmployeeID, NodeID: in.NodeID, EventID: mustUUID(t), TaskID: in.TaskID,
		ExecutionID: in.ExecutionID, SessionID: in.SessionID, Kind: task.EventResult,
		InputGeneration: 1, Status: task.StatusCompleted, Summary: "没有停止",
		EvidenceEmptyReason: "无", ArtifactsEmptyReason: "无", AgentStopped: false,
	})
	if err != nil || blocked || code != task.CodeConflict {
		t.Fatalf("未停止的成功被接受: %v %v %s", err, blocked, code)
	}
}

func TestOpenChildBlocksCompletion(t *testing.T) {
	ctx, repo, pool, in, ident := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	child, err := repo.AcceptTask(ctx, in.EmployeeID, task.Input{
		RequestID: "child-" + mustUUID(t), Description: "子委托", ParentTaskID: &in.TaskID, TargetNodeID: &ident.NodeID,
	})
	if err != nil || child.TaskID == "" {
		t.Fatal(err)
	}
	ack, code, err := repo.ApplyExecutionReport(ctx, completedReport(in, mustUUID(t)))
	if err != nil || ack || code != "delegation_pending" {
		t.Fatalf("有未完成子委托时仍完成了任务: %v %v %s", err, ack, code)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM tasks WHERE id = $1::uuid`, in.TaskID).Scan(&status); err != nil || status != task.StatusQueued {
		t.Fatalf("被挡住的任务状态是 %s %v", status, err)
	}
}

func startedReport(in store.StartRequest, eventID string) store.ExecutionReport {
	return store.ExecutionReport{
		EmployeeID: in.EmployeeID, NodeID: in.NodeID, EventID: eventID, TaskID: in.TaskID,
		ExecutionID: in.ExecutionID, SessionID: in.SessionID, Kind: task.EventStarted,
		InputGeneration: 1, Status: task.StatusRunning,
	}
}

func completedReport(in store.StartRequest, eventID string) store.ExecutionReport {
	return store.ExecutionReport{
		EmployeeID: in.EmployeeID, NodeID: in.NodeID, EventID: eventID, TaskID: in.TaskID,
		ExecutionID: in.ExecutionID, SessionID: in.SessionID, Kind: task.EventResult,
		InputGeneration: 1, Status: task.StatusCompleted, Summary: "计数执行器已交回结构化结果",
		Evidence: []task.ResultRef{{
			StorageRef: "executor-note", ResourceID: "count-1", AccessStatus: task.AccessAvailable,
		}},
		ArtifactsEmptyReason: "这次执行没有文件产物", AgentStopped: true,
	}
}

func TestFormatFailureIsNotCompleted(t *testing.T) {
	ctx, repo, pool, in, _ := preparedStart(t)
	if _, err := repo.AuthorizeStart(ctx, in); err != nil {
		t.Fatal(err)
	}
	failure := task.FormatFailure(false)
	ack, code, err := repo.ApplyExecutionReport(ctx, store.ExecutionReport{
		EmployeeID: in.EmployeeID, NodeID: in.NodeID, EventID: mustUUID(t), TaskID: in.TaskID,
		ExecutionID: in.ExecutionID, SessionID: in.SessionID, Kind: task.EventResult,
		InputGeneration: 1, Status: failure.Status, Summary: failure.Summary,
		EvidenceEmptyReason: failure.EvidenceEmptyReason, ArtifactsEmptyReason: failure.ArtifactsEmptyReason,
		ErrorCode: failure.ErrorCode, ErrorMessage: failure.ErrorMessage, AgentStopped: true,
	})
	if err != nil || !ack || code != "" {
		t.Fatalf("格式错误没有保存: %v %s", err, code)
	}
	var status, summary, errorCode string
	if err := pool.QueryRow(ctx, `
		SELECT status, summary, error_code FROM tasks WHERE id = $1::uuid`, in.TaskID).Scan(&status, &summary, &errorCode); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusFailed || errorCode != task.CodeResultFormat || summary == "完成" {
		t.Fatalf("格式错误被当成成功: %s %s %s", status, errorCode, summary)
	}
}

package gateway_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/session"
	"baton/internal/task"
)

func TestExecutionPersistsStructuredResultOnce(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":       "0",
		"BATON_TEST_EXECUTOR_SCRIPT":  "success",
		"BATON_TEST_DUPLICATE_REPORT": "1",
	})
	created := acceptTask(t, st, "result-once")
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	var sessionID, summary, nodeID string
	var deliveries, executions int
	if err := st.pool.QueryRow(context.Background(), `
		SELECT t.target_session_id::text, t.summary, t.target_node_id::text,
		       (SELECT COUNT(*) FROM delivery_records WHERE task_id = t.id),
		       (SELECT COUNT(*) FROM executions WHERE task_id = t.id)
		FROM tasks t WHERE t.id = $1::uuid`, created.TaskID).Scan(&sessionID, &summary, &nodeID, &deliveries, &executions); err != nil {
		t.Fatal(err)
	}
	if summary != session.SuccessSummary || nodeID != st.ident.NodeID || deliveries != 1 || executions != 1 || sessionID == "" {
		t.Fatalf("中心结果不正确: summary %q node %s deliveries %d executions %d session %s", summary, nodeID, deliveries, executions, sessionID)
	}
	assertCenterOmits(t, st, created.TaskID, session.LocalHistoryMarker)
	assertCenterOmits(t, st, created.TaskID, session.ForgedTaskID)
	path, err := session.LedgerPath(st.dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if countLocal(t, path, session.LocalHistoryMarker) == 0 || countLocal(t, path, session.ForgedTaskID) == 0 {
		t.Fatal("节点账本没有留下执行过程和原始结果")
	}
	waitResultDelivered(t, st.dataDir, sessionID)
	client := dialWorker(t, st.dataDir, sessionID)
	defer client.Close()
	again, err := client.SubmitInput(`{"description":"重复命令"}`)
	if err != nil || again.ExecutorInputs != 1 || !again.ResultDelivered {
		t.Fatalf("重复命令产生了另一次执行或提前确认了交付: %v %+v", err, again)
	}
	raw, err := os.ReadFile(filepath.Join(st.dataDir, "executor.log"))
	if err != nil || strings.Count(string(raw), "input\n") != 1 || strings.Count(string(raw), "start\n") != 1 {
		t.Fatalf("执行器日志不是一次输入: %q %v", raw, err)
	}
	var view task.Record
	if err := getJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID, &view); err != nil {
		t.Fatal(err)
	}
	if view.TaskID != created.TaskID || view.TargetNodeID != st.ident.NodeID || view.Status != task.StatusCompleted || view.TargetSessionID == nil || *view.TargetSessionID != sessionID {
		t.Fatalf("查询到的任务关联不正确: %+v", view)
	}
	if view.Summary == nil || *view.Summary != session.SuccessSummary || len(view.Evidence) != 1 || view.Artifacts != nil {
		t.Fatalf("查询到的结果不正确: %+v", view)
	}
}

func TestExecutionDeliveryWaitsForCenterCommit(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_RESULT_GATE":     gate,
	})
	created := acceptTask(t, st, "result-gate")
	eventID := waitGateFile(t, gate)
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	var deliveries int
	var summary *string
	if err := st.pool.QueryRow(context.Background(), `
		SELECT COUNT(*), (SELECT summary FROM tasks WHERE id = $1::uuid)
		FROM delivery_records WHERE task_id = $1::uuid`, created.TaskID).Scan(&deliveries, &summary); err != nil {
		t.Fatal(err)
	}
	if deliveries != 0 || summary != nil {
		t.Fatalf("中心在提交前就保存了结果: %d %v", deliveries, summary)
	}
	var sessionID string
	if err := st.pool.QueryRow(context.Background(), `SELECT target_session_id::text FROM tasks WHERE id = $1::uuid`, created.TaskID).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if workerStatus(t, st.dataDir, sessionID).ResultDelivered {
		t.Fatal("中心尚未持久化就确认了结果交付")
	}
	releaseGate(t, gate, eventID)
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) && !workerStatus(t, st.dataDir, sessionID).ResultDelivered {
		time.Sleep(100 * time.Millisecond)
	}
	if !workerStatus(t, st.dataDir, sessionID).ResultDelivered {
		t.Fatal("持久化之后仍然没有确认交付")
	}
	if err := st.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM delivery_records WHERE task_id = $1::uuid`, created.TaskID).Scan(&deliveries); err != nil || deliveries != 1 {
		t.Fatalf("持久化后的交付记录是 %d %v", deliveries, err)
	}
}

func TestExecutionFreeTextAndExitAreNotSuccess(t *testing.T) {
	for _, script := range []string{"text", "exit"} {
		t.Run(script, func(t *testing.T) {
			st := startPrepareStack(t, map[string]string{
				"BATON_TEST_HOLD_START":      "0",
				"BATON_TEST_EXECUTOR_SCRIPT": script,
			})
			created := acceptTask(t, st, "result-"+script)
			waitTaskStatus(t, st, created.TaskID, task.StatusFailed)
			var code, summary string
			if err := st.pool.QueryRow(context.Background(), `
				SELECT error_code, summary FROM tasks WHERE id = $1::uuid`, created.TaskID).Scan(&code, &summary); err != nil {
				t.Fatal(err)
			}
			if code != task.CodeResultFormat || strings.Contains(summary, "完成") {
				t.Fatalf("%s 被当成成功: %s %s", script, code, summary)
			}
			assertCenterOmits(t, st, created.TaskID, "完成")
		})
	}
}

func waitResultDelivered(t *testing.T, dataDir, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last session.Status
	for time.Now().Before(deadline) {
		last = workerStatus(t, dataDir, sessionID)
		if last.ResultDelivered {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("中心已经保存结果，Worker 仍未确认交付: %+v", last)
}

func assertCenterOmits(t *testing.T, st *prepareStack, taskID, needle string) {
	t.Helper()
	var leaked int
	if err := st.pool.QueryRow(context.Background(), `
		SELECT
			(SELECT COUNT(*) FROM tasks WHERE id = $1::uuid AND (
				COALESCE(summary, '') LIKE '%' || $2 || '%'
				OR COALESCE(error_message, '') LIKE '%' || $2 || '%'
				OR COALESCE(evidence_empty_reason, '') LIKE '%' || $2 || '%'
				OR COALESCE(artifacts_empty_reason, '') LIKE '%' || $2 || '%'
				OR description LIKE '%' || $2 || '%'))
			+ (SELECT COUNT(*) FROM task_result_refs WHERE task_id = $1::uuid AND (
				resource_id LIKE '%' || $2 || '%' OR COALESCE(note, '') LIKE '%' || $2 || '%'
				OR COALESCE(storage_ref, '') LIKE '%' || $2 || '%' OR COALESCE(node_id::text, '') = $2))
			+ (SELECT COUNT(*) FROM task_events WHERE task_id = $1::uuid AND (
				id::text = $2 OR COALESCE(reason_code, '') = $2))
			+ (SELECT COUNT(*) FROM delivery_records WHERE task_id = $1::uuid AND id::text = $2)
		`, taskID, needle).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("中心记录出现了 %s: %v %d", needle, err, leaked)
	}
}

func countLocal(t *testing.T, path, needle string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM execution_log WHERE body LIKE '%' || ? || '%'`, needle).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

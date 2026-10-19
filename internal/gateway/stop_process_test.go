package gateway_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"baton/internal/session"
	"baton/internal/task"
)

func TestCancelBeforePermitDrainsStopReportAcrossBatondRestarts(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_START_GATE": gate})
	created := acceptTask(t, st, "cancel-before-permit-stop")
	waitGateFile(t, gate)
	sid := taskWorker(t, st, created.TaskID)
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, nil); code != 200 {
		t.Fatalf("授权前取消: %d", code)
	}
	waitTaskStatus(t, st, created.TaskID, task.StatusCancelled)
	waitStopEvidence(t, st, created.TaskID)
	path, err := session.LedgerPath(st.dataDir, sid)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var pending int
		if err := db.QueryRow(`SELECT COUNT(*) FROM outbox WHERE delivered = 0`).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		if pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("中止回执未清空: %d\n%s", pending, st.batond.out.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	assertDrained := func() {
		t.Helper()
		var status string
		var authorized bool
		var reports int
		if err := st.pool.QueryRow(context.Background(), `SELECT t.status, e.start_authorized_at IS NOT NULL,
 (SELECT COUNT(*) FROM task_events WHERE task_id = t.id AND kind = 'stop_report' AND not_started)
 FROM tasks t JOIN executions e ON e.task_id = t.id WHERE t.id = $1::uuid`, created.TaskID).Scan(&status, &authorized, &reports); err != nil || status != task.StatusCancelled || authorized || reports != 1 {
			t.Fatalf("中心终态或补充证据错误: %s authorized %v reports %d %v", status, authorized, reports, err)
		}
		var pending, total int
		if err := db.QueryRow(`SELECT COUNT(*) FILTER (WHERE delivered = 0), COUNT(*) FROM outbox`).Scan(&pending, &total); err != nil || pending != 0 || total != 1 {
			t.Fatalf("心跳产生未交付或重复回执: pending %d total %d %v", pending, total, err)
		}
		if needs, err := session.LedgerNeedsWorker(path); err != nil || needs {
			t.Fatalf("已交付取消账本仍需 Worker: %v %v", needs, err)
		}
		for _, kind := range []string{"start", "input"} {
			if n := executorCount(t, st, kind); n != 0 {
				t.Fatalf("授权前取消后执行器 %s %d 次", kind, n)
			}
		}
	}
	waitHeartbeats := func() {
		t.Helper()
		var last time.Time
		if err := st.pool.QueryRow(context.Background(), `SELECT last_contact_at FROM node_presence WHERE node_id = $1::uuid`, st.ident.NodeID).Scan(&last); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 3; i++ {
			deadline := time.Now().Add(10 * time.Second)
			for {
				var next time.Time
				if err := st.pool.QueryRow(context.Background(), `SELECT last_contact_at FROM node_presence WHERE node_id = $1::uuid`, st.ident.NodeID).Scan(&next); err != nil {
					t.Fatal(err)
				}
				if next.After(last) {
					last = next
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("未观察到新心跳")
				}
				time.Sleep(50 * time.Millisecond)
			}
			assertDrained()
		}
	}
	waitHeartbeats()
	pid := workerStatus(t, st.dataDir, sid).PID
	st.batond.stop()
	stopWorker(pid)
	waitWorkerSocketDown(t, st.dataDir, sid)
	for i := 0; i < 2; i++ {
		restartBatond(t, st)
		waitLog(t, st.batond, "event=connected")
		waitLog(t, st.batond, "event=synced")
		waitHeartbeats()
		host := session.Host{DataDir: st.dataDir}
		if host.Reachable(context.Background(), sid) || strings.Contains(st.batond.out.String(), "event=worker_started") {
			t.Fatalf("重启后重新拉起已交付的 Worker\n%s", st.batond.out.String())
		}
	}
}

func TestRunningCancelNeedsWorkerStopAndOutcomeEvidence(t *testing.T) {
	for _, script := range []string{"unconfirmed", "unknown", "confirmed"} {
		t.Run(script, func(t *testing.T) {
			st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_ABORT_SCRIPT": script})
			created := acceptTask(t, st, "cancel-"+script)
			waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
			sid := taskWorker(t, st, created.TaskID)
			var response struct {
				Status        string `json:"status"`
				PossibleStart bool   `json:"possible_start"`
			}
			if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, &response); code != 200 || response.Status != task.StatusNeedsVerification || !response.PossibleStart {
				t.Fatalf("请求误显示已停止: %d %+v", code, response)
			}
			view := waitStopEvidence(t, st, created.TaskID)
			want := task.StatusNeedsVerification
			if script == "confirmed" {
				want = task.StatusCancelled
			}
			if view.Status != want || view.CancelRequestedAt == nil || view.StopOutcomeKnown != (script == "confirmed") || (view.StopConfirmedAt != nil) != (script != "unconfirmed") {
				t.Fatalf("错误的停止保证: %+v", view)
			}
			if n := executorCount(t, st, "input"); n != 1 {
				t.Fatalf("取消后重复输入: %d", n)
			}
			client := dialWorker(t, st.dataDir, sid)
			defer client.Close()
			if status, err := client.SubmitInput("不得再次执行"); err != nil || status.ExecutorInputs != 1 || !status.Cancelled {
				t.Fatalf("Worker 没拦住补发: %+v %v", status, err)
			}
		})
	}
}

func TestHeartbeatResendChecksPersistedCancellationAndDeadline(t *testing.T) {
	for _, reason := range []string{task.StatusCancelled, task.CodeExecutionTimeout, task.CodeQueueTimeout} {
		t.Run(reason, func(t *testing.T) {
			gate := t.TempDir()
			st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_INPUT_GATE": gate})
			created := acceptTask(t, st, "resend-block-"+reason)
			waitGateFile(t, gate)
			sid := taskWorker(t, st, created.TaskID)
			if status := workerStatus(t, st.dataDir, sid); !status.StartIntent || status.InputSubmitted {
				t.Fatalf("前提不是存活但尚未送输入: %+v", status)
			}
			st.batond.stop()
			if reason == task.StatusCancelled {
				if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, nil); code != 200 {
					t.Fatalf("取消: %d", code)
				}
			} else if reason == task.CodeExecutionTimeout {
				if _, err := st.pool.Exec(context.Background(), `UPDATE tasks SET execution_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, created.TaskID); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := st.pool.Exec(context.Background(), `UPDATE tasks SET created_at = now() - interval '1 hour', queue_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, created.TaskID); err != nil {
					t.Fatal(err)
				}
			}
			st.batondEnv = dropEnv(st.batondEnv, "BATON_TEST_INPUT_GATE")
			restartBatond(t, st)
			want := task.StatusFailed
			if reason == task.StatusCancelled {
				want = task.StatusCancelled
			}
			waitTaskStatus(t, st, created.TaskID, want)
			view := waitStopEvidence(t, st, created.TaskID)
			if view.StopReason == nil || *view.StopReason != reason || !view.StopOutcomeKnown || view.StopConfirmedAt == nil {
				t.Fatalf("补发未按真实未发送事实收敛: %+v", view)
			}
			if n := executorCount(t, st, "input"); n != 0 {
				t.Fatalf("取消/到期后重放了 %d 次输入", n)
			}
			if status := workerStatus(t, st.dataDir, sid); !status.Cancelled || status.InputSubmitted {
				t.Fatalf("Worker 未持久拒绝输入: %+v", status)
			}
		})
	}
}

func TestHeartbeatResendRecordsActualDelayWithoutReplay(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_INPUT_GATE": gate})
	created := acceptTask(t, st, "resend-delay")
	waitGateFile(t, gate)
	sid := taskWorker(t, st, created.TaskID)
	st.batond.stop()
	time.Sleep(250 * time.Millisecond)
	st.batondEnv = dropEnv(st.batondEnv, "BATON_TEST_INPUT_GATE")
	restartBatond(t, st)
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	path, err := session.LedgerPath(st.dataDir, sid)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var body string
	if err := db.QueryRow(`SELECT body FROM execution_log WHERE kind = 'input_dispatch'`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	var ev struct {
		DueAt   time.Time `json:"due_at"`
		SentAt  time.Time `json:"sent_at"`
		DelayMS int64     `json:"delay_ms"`
	}
	if err := json.Unmarshal([]byte(body), &ev); err != nil || ev.DelayMS < 250 || ev.DueAt.IsZero() || !ev.SentAt.After(ev.DueAt) {
		t.Fatalf("实际补发延迟证据: %s %v", body, err)
	}
	if n := executorCount(t, st, "input"); n != 1 {
		t.Fatalf("恢复输入不为一次: %d", n)
	}
}

func TestOfflineWorkerEnforcesExecutionDeadline(t *testing.T) {
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0"})
	var created task.Record
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{"request_id": "offline-timeout", "description": "离线执行期限", "execution_timeout_seconds": 2}, st.csrf, &created); code != 200 {
		t.Fatalf("接受: %d", code)
	}
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	sid := taskWorker(t, st, created.TaskID)
	st.batond.stop()
	deadline := time.Now().Add(8 * time.Second)
	var status session.Status
	for time.Now().Before(deadline) {
		status = workerStatus(t, st.dataDir, sid)
		if status.Cancelled {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !status.Cancelled {
		t.Fatal("离线 Worker 没有自行中止")
	}
	if n := executorCount(t, st, "abort"); n != 1 {
		t.Fatalf("离线中止次数 %d", n)
	}
	st.batondEnv = dropEnv(st.batondEnv, "BATON_TEST_INPUT_GATE")
	restartBatond(t, st)
	waitTaskStatus(t, st, created.TaskID, task.StatusFailed)
	view := waitStopEvidence(t, st, created.TaskID)
	if view.ErrorCode == nil || *view.ErrorCode != task.CodeExecutionTimeout || view.StopConfirmedAt == nil || !view.StopOutcomeKnown {
		t.Fatalf("离线确认未补报: %+v", view)
	}
	if n := executorCount(t, st, "input"); n != 1 {
		t.Fatalf("到期重放了输入: %d", n)
	}
}

func TestCompletedWorkerResultRacingCancelRetainsCompletion(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_EXECUTOR_SCRIPT": "success", "BATON_TEST_RESULT_GATE": gate})
	created := acceptTask(t, st, "completion-cancel")
	eventID := waitGateFile(t, gate)
	taskWorker(t, st, created.TaskID)
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, nil); code != 200 {
		t.Fatalf("取消: %d", code)
	}
	releaseGate(t, gate, eventID)
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	view := waitStopEvidence(t, st, created.TaskID)
	if view.Status != task.StatusCompleted || view.CancelRequestedAt == nil || view.Summary == nil || *view.Summary != session.SuccessSummary {
		t.Fatalf("取消覆盖真实完成: %+v", view)
	}
	var seqResult, seqStop int64
	if err := st.pool.QueryRow(context.Background(), `SELECT MAX(worker_sequence) FILTER (WHERE kind = 'result'), MAX(worker_sequence) FILTER (WHERE kind = 'stop_report') FROM task_events WHERE task_id = $1::uuid`, created.TaskID).Scan(&seqResult, &seqStop); err != nil || seqResult <= 0 || seqStop <= seqResult {
		t.Fatalf("本地完成先于取消的证据丢失: %d %d %v", seqResult, seqStop, err)
	}
}

func waitStopEvidence(t *testing.T, st *prepareStack, taskID string) task.Record {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var view task.Record
	for time.Now().Before(deadline) {
		if err := getJSON(t, st.client, st.base+"/api/v1/tasks/"+taskID, &view); err != nil {
			t.Fatal(err)
		}
		if view.StopAcknowledgedAt != nil {
			return view
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("没有 Worker 中止回执: %+v\n%s", view, st.batond.out.String())
	return view
}

func taskWorker(t *testing.T, st *prepareStack, taskID string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var sid string
	for time.Now().Before(deadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT COALESCE(target_session_id::text, '') FROM tasks WHERE id = $1::uuid`, taskID).Scan(&sid); err != nil {
			t.Fatal(err)
		}
		if sid != "" {
			_ = workerStatus(t, st.dataDir, sid)

			return sid
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("中心没有保存目标 Session\ncoord %s\nnode %s", st.coord.out.String(), st.batond.out.String())
	return ""
}

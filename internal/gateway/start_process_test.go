package gateway_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/node"
	"baton/internal/startpermit"
	"baton/internal/task"
)

func TestStartPermitEntersObservableExecutor(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":  "0",
		"BATON_TEST_WALL_OFFSET": "24h",
	})
	created := acceptTask(t, st, "start-ok")
	waitExecutor(t, st, "start\ninput\n")
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	assertNoHooks(t, st, created.TaskID)
	var status string
	var authorized, refused bool
	if err := st.pool.QueryRow(context.Background(), `
		SELECT t.status, e.start_authorized_at IS NOT NULL, e.start_refused_at IS NOT NULL
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, created.TaskID).Scan(&status, &authorized, &refused); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusRunning || !authorized || refused {
		t.Fatalf("启动后的中心状态不正确: %s authorized %v refused %v", status, authorized, refused)
	}
	if strings.Contains(st.coord.out.String(), "eyJ") {
		t.Fatal("日志里出现了许可正文")
	}
}

func TestStartPermitCancelRacePreservesPossibleStart(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":  "0",
		"BATON_TEST_START_DELAY": "1s",
	})
	created := acceptTask(t, st, "start-race")
	waitLog(t, st.coord, "event=start_authorized")
	var view struct {
		Status        string `json:"status"`
		PossibleStart bool   `json:"possible_start"`
	}
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, &view); code != 200 || view.Status != task.StatusNeedsVerification || !view.PossibleStart {
		t.Fatalf("竞态取消得到 %d %+v", code, view)
	}
	waitTaskStatus(t, st, created.TaskID, task.StatusCancelled)
	var cancelled, cancelRequested bool
	if err := st.pool.QueryRow(context.Background(), `
		SELECT status = 'cancelled', cancel_requested_at IS NOT NULL
		FROM tasks WHERE id = $1::uuid`, created.TaskID).Scan(&cancelled, &cancelRequested); err != nil || !cancelled || !cancelRequested {
		t.Fatalf("取消未按 Worker 确认收敛: %v cancelled %v cancel %v", err, cancelled, cancelRequested)
	}
	if n := executorCount(t, st, "input"); n != 0 {
		t.Fatalf("取消标记后仍补发了 %d 次输入", n)
	}
}

func TestStartPermitCancelAndRevokeBeforeIssue(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START": "0",
		"BATON_TEST_START_GATE": gate,
	})
	created := acceptTask(t, st, "start-before")
	executionID := waitGateFile(t, gate)
	var view struct {
		Status        string `json:"status"`
		PossibleStart bool   `json:"possible_start"`
	}
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, &view); code != 200 || view.Status != task.StatusCancelled || view.PossibleStart {
		t.Fatalf("授权前取消得到 %d %+v", code, view)
	}
	releaseGate(t, gate, executionID)
	time.Sleep(700 * time.Millisecond)
	if raw, err := os.ReadFile(filepath.Join(st.dataDir, "executor.log")); err == nil && len(raw) > 0 {
		t.Fatalf("取消后仍然启动: %s", raw)
	}
	var authorized bool
	if err := st.pool.QueryRow(context.Background(), `
		SELECT e.start_authorized_at IS NOT NULL FROM executions e WHERE e.task_id = $1::uuid`, created.TaskID).Scan(&authorized); err != nil || authorized {
		t.Fatalf("取消前的任务被授权了: %v %v", err, authorized)
	}

	revoked := acceptTask(t, st, "start-revoked")
	revExec := waitGateFile(t, gate)
	if _, err := st.pool.Exec(context.Background(), `UPDATE nodes SET revoked_at = now() WHERE id = $1::uuid`, st.ident.NodeID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.pool.Exec(context.Background(), `UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1::uuid`, st.ident.NodeID); err != nil {
		t.Fatal(err)
	}
	releaseGate(t, gate, revExec)
	time.Sleep(700 * time.Millisecond)
	var status string
	if err := st.pool.QueryRow(context.Background(), `SELECT t.status,e.start_authorized_at IS NOT NULL FROM tasks t JOIN executions e ON e.task_id=t.id WHERE t.id=$1::uuid`, revoked.TaskID).Scan(&status, &authorized); err != nil || authorized || status != task.StatusQueued {
		t.Fatalf("已吊销消息被分派: %s %v %v", status, authorized, err)
	}

	if raw, err := os.ReadFile(filepath.Join(st.dataDir, "executor.log")); err == nil && strings.Contains(string(raw), "start") {
		t.Fatal("吊销后进入了启动")
	}
}

func TestStartPermitSuspendAndWrongGenerationDoNotStart(t *testing.T) {
	permitFile := filepath.Join(t.TempDir(), "permit.txt")
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":       "0",
		"BATON_TEST_PERMIT_FILE":      permitFile,
		"BATON_TEST_WAIT_PERMIT_FILE": "1",
	})
	created := acceptTask(t, st, "start-bad")
	waitLog(t, st.coord, "event=start_authorized")
	signer, err := node.LoadSigner(st.signingFile)
	if err != nil {
		t.Fatal(err)
	}
	var claims startpermit.Claims
	var issued, expires, queue time.Time
	var hash []byte
	if err := st.pool.QueryRow(context.Background(), `
		SELECT t.target_node_id::text, t.employee_id::text, t.id::text, e.id::text,
		       e.storage_generation, e.permit_nonce, t.request_hash,
		       e.start_authorized_at, e.start_permit_expires_at, t.queue_expires_at
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, created.TaskID).Scan(
		&claims.NodeID, &claims.EmployeeID, &claims.TaskID, &claims.ExecutionID,
		&claims.StorageGeneration, &claims.Nonce, &hash, &issued, &expires, &queue,
	); err != nil {
		t.Fatal(err)
	}
	claims.RequestHash = hash
	claims.IssuedAt = issued.UTC()
	claims.ExpiresAt = expires.UTC()
	claims.QueueExpiresAt = queue.UTC()
	claims.StorageGeneration = "wrong-generation"
	token, err := signer.SignStartPermit(claims)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(permitFile, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitLog(t, st.batond, "event=start_refusal_sent")
	// 中心保存拒绝回执后，数据库才包含拒绝事实。
	waitLog(t, st.coord, "event=start_refused")
	if raw, err := os.ReadFile(filepath.Join(st.dataDir, "executor.log")); err == nil && strings.Contains(string(raw), "start") {
		t.Fatalf("错误代次启动了执行器: %s", raw)
	}
	var status string
	var refused bool
	if err := st.pool.QueryRow(context.Background(), `
		SELECT t.status, e.start_refused_at IS NOT NULL
		FROM tasks t JOIN executions e ON e.task_id = t.id
		WHERE t.id = $1::uuid`, created.TaskID).Scan(&status, &refused); err != nil || status != task.StatusQueued || !refused {
		t.Fatalf("错误代次的中心记录不正确: %v %s refused %v", err, status, refused)
	}
}

func TestSuspendAloneRefusesStart(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":        "0",
		"BATON_TEST_SUSPEND_AFTER_ARM": "6s",
	})
	created := acceptTask(t, st, "start-suspend")
	waitLog(t, st.batond, "event=start_refusal_sent")
	// 节点发出回执后，中心还要写库；等中心记录完再取消，否则会按“许可已发出、尚无回执”得到待核实。
	waitLog(t, st.coord, "event=start_refused")
	if raw, err := os.ReadFile(filepath.Join(st.dataDir, "executor.log")); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		t.Fatalf("暂停后仍然启动: %s", raw)
	}
	var view struct {
		Status        string `json:"status"`
		PossibleStart bool   `json:"possible_start"`
	}
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, &view); code != 200 || view.Status != task.StatusCancelled || view.PossibleStart {
		t.Fatalf("已有未启动回执的取消得到 %d %+v log %s", code, view, st.coord.out.String())
	}
}

func acceptTask(t *testing.T, st *prepareStack, requestID string) task.Record {
	t.Helper()
	var created task.Record
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{
		"request_id": requestID, "description": "启动许可",
	}, st.csrf, &created); code != 200 || created.TaskID == "" {
		t.Fatalf("接受任务状态 %d %+v", code, created)
	}
	return created
}

func waitExecutor(t *testing.T, st *prepareStack, want string) {
	t.Helper()
	path := filepath.Join(st.dataDir, "executor.log")
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(path)
		if err == nil && string(raw) == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	raw, _ := os.ReadFile(path)
	t.Fatalf("执行器日志是 %q\ncoord %s\nnode %s", raw, st.coord.out.String(), st.batond.out.String())
}

func assertNoHooks(t *testing.T, st *prepareStack, taskID string) {
	t.Helper()
	var sessionID string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_ = st.pool.QueryRow(context.Background(), `SELECT COALESCE(target_session_id::text, '') FROM tasks WHERE id = $1::uuid`, taskID).Scan(&sessionID)
		if sessionID != "" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	stStatus := workerStatus(t, st.dataDir, sessionID)
	if stStatus.ExecutorStarts != 1 || stStatus.ExecutorInputs != 1 || stStatus.HookRuns != 0 {
		t.Fatalf("执行器计数不正确: %+v", stStatus)
	}
}

func waitTaskStatus(t *testing.T, st *prepareStack, taskID, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var status string
	for time.Now().Before(deadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT status FROM tasks WHERE id = $1::uuid`, taskID).Scan(&status); err == nil && status == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("任务状态是 %s，想要 %s\ncoord %s\nnode %s", status, want, st.coord.out.String(), st.batond.out.String())
}

func waitGateFile(t *testing.T, gate string, stacks ...*prepareStack) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		matches, _ := filepath.Glob(filepath.Join(gate, "waiting-*"))
		for _, name := range matches {
			id := strings.TrimPrefix(filepath.Base(name), "waiting-")
			release := filepath.Join(gate, "release-"+id)
			if _, err := os.Stat(release); os.IsNotExist(err) {
				return id
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, st := range stacks {
		t.Logf("coord %s\nnode %s\nrelay %s", st.coord.out.String(), st.batond.out.String(), st.coord.out.String())
	}
	t.Fatal("没有等到测试门闩")
	return ""
}

func releaseGate(t *testing.T, gate, executionID string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(gate, "release-"+executionID), []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

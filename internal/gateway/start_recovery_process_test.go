package gateway_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/session"
	"baton/internal/task"
)

func TestCentralStartRejectionDoesNotRespawnWorker(t *testing.T) {
	for _, workerExited := range []bool{false, true} {
		name := "worker_alive"
		if workerExited {
			name = "worker_exited"
		}
		t.Run(name, func(t *testing.T) {
			gate := t.TempDir()
			st := startPrepareStack(t, map[string]string{
				"BATON_TEST_HOLD_START": "0",
				"BATON_TEST_START_GATE": gate,
			})
			created := acceptTask(t, st, name)
			executionID := waitGateFile(t, gate)
			waitLog(t, st.coord, "event=prepare_saved")
			sessionID := sessionOf(t, st, created.TaskID)
			before := workerStatus(t, st.dataDir, sessionID)
			t.Cleanup(func() { stopWorker(before.PID) })
			// 中心已有另一 nonce 的许可；隔离 conflict 拒绝，不触发中止回执恢复。
			if _, err := st.pool.Exec(context.Background(), `UPDATE executions
				SET start_authorized_at = now(), start_permit_expires_at = now() + interval '5 seconds', permit_nonce = $2
				WHERE id = $1::uuid`, executionID, newID(t)); err != nil {
				t.Fatal(err)
			}
			if workerExited {
				ctx := context.Background()
				tx, err := st.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = tx.Rollback(ctx) }()
				if _, err := tx.Exec(ctx, `SELECT id FROM tasks WHERE id = $1::uuid FOR UPDATE`, created.TaskID); err != nil {
					t.Fatal(err)
				}
				releaseGate(t, gate, executionID)
				waitLog(t, st.batond, "event=start_permit_requested")
				stopWorker(before.PID)
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				releaseGate(t, gate, executionID)
			}
			waitLog(t, st.batond, "event=start_rejected")
			path, err := session.LedgerPath(st.dataDir, sessionID)
			if err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var code string
			if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'start_refused'`).Scan(&code); err != nil || code != task.CodeConflict {
				t.Fatalf("中心拒绝未落盘: %s %v", code, err)
			}
			if workerExited && workerStatus(t, st.dataDir, sessionID).PID == before.PID {
				t.Fatal("中心拒绝到达前原 Worker 没有退出")
			}
			assertWorkerStaysDownAfterRestart(t, st, sessionID, created.TaskID)
		})
	}
}

func TestPreparedWorkerRecoveryDependsOnStartRequest(t *testing.T) {
	for _, requested := range []bool{false, true} {
		name := "never_requested"
		if requested {
			name = "waiting_for_permit"
		}
		t.Run(name, func(t *testing.T) {
			st := startPrepareStack(t, nil)
			created := acceptTask(t, st, name)
			waitLog(t, st.batond, "event=prepare_acked")
			waitLog(t, st.coord, "event=prepare_saved")
			sessionID := sessionOf(t, st, created.TaskID)
			if !requested {
				assertWorkerStaysDownAfterRestart(t, st, sessionID, created.TaskID)
				return
			}
			execID, _ := oneReceipt(t, st.dataDir)
			host := &session.Host{DataDir: st.dataDir}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := host.Arm(ctx, sessionID, created.TaskID, execID); err != nil {
				t.Fatal(err)
			}
			before := workerStatus(t, st.dataDir, sessionID)
			st.batond.stop()
			stopWorker(before.PID)
			waitWorkerSocketDown(t, st.dataDir, sessionID)
			restartBatond(t, st)
			waitLog(t, st.batond, "event=synced")
			after := workerStatus(t, st.dataDir, sessionID)
			t.Cleanup(func() { stopWorker(after.PID) })
			if after.PID == before.PID || after.StartIntent || after.ExecutorStarts != 0 || after.ExecutorInputs != 0 {
				t.Fatalf("等待许可的 Worker 没有安全恢复: before %+v after %+v", before, after)
			}
			assertSingleUnstartedExecution(t, st, created.TaskID)
		})
	}
}

func TestStartRefusalPersistenceFailureStillReportsToCenter(t *testing.T) {
	permitFile := filepath.Join(t.TempDir(), "permit.txt")
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":       "0",
		"BATON_TEST_PERMIT_FILE":      permitFile,
		"BATON_TEST_WAIT_PERMIT_FILE": "1",
	})
	created := acceptTask(t, st, "refusal-write-failure")
	waitLog(t, st.batond, "event=start_permit_held")
	sessionID := sessionOf(t, st, created.TaskID)
	worker := workerStatus(t, st.dataDir, sessionID)
	t.Cleanup(func() { stopWorker(worker.PID) })
	path, err := session.LedgerPath(st.dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TRIGGER fail_refusal BEFORE INSERT ON meta
		WHEN NEW.key = 'start_refused' BEGIN SELECT RAISE(ABORT, 'test refusal failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(permitFile, []byte("invalid-permit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitLog(t, st.coord, "event=start_refused")
	var refused bool
	if err := st.pool.QueryRow(context.Background(), `SELECT start_refused_at IS NOT NULL FROM executions WHERE task_id = $1::uuid`, created.TaskID).Scan(&refused); err != nil || !refused {
		t.Fatalf("拒绝写库失败后中心没有收到回执: %v %v", refused, err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM meta WHERE key = 'start_refused'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("故障注入没有阻止拒绝落盘: %d %v", count, err)
	}
	assertSingleUnstartedExecution(t, st, created.TaskID)
}

func assertWorkerStaysDownAfterRestart(t *testing.T, st *prepareStack, sessionID, taskID string) {
	t.Helper()
	before := workerStatus(t, st.dataDir, sessionID)
	st.batond.stop()
	stopWorker(before.PID)
	waitWorkerSocketDown(t, st.dataDir, sessionID)
	host := &session.Host{DataDir: st.dataDir}
	for range 2 {
		restartBatond(t, st)
		waitLog(t, st.batond, "event=synced")
		// 覆盖启动重连及多次心跳恢复扫描。
		time.Sleep(700 * time.Millisecond)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		reachable := host.Reachable(ctx, sessionID)
		cancel()
		if reachable {
			t.Fatalf("不再等待许可的 Session 被重新拉起: %+v\n%s", workerStatus(t, st.dataDir, sessionID), st.batond.out.String())
		}
	}
	assertSingleUnstartedExecution(t, st, taskID)
}

func assertSingleUnstartedExecution(t *testing.T, st *prepareStack, taskID string) {
	t.Helper()
	_, executions, _ := taskFacts(t, st, taskID)
	if executions != 1 || executorCount(t, st, "start") != 0 || executorCount(t, st, "input") != 0 {
		t.Fatalf("产生了额外执行或输入: executions %d starts %d inputs %d", executions, executorCount(t, st, "start"), executorCount(t, st, "input"))
	}
}

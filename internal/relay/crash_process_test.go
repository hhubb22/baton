package relay_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"

	_ "modernc.org/sqlite"
)

func TestCrashAfterStartIntentDoesNotSendInput(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "start_intent",
	})
	created := acceptTask(t, st, "crash-intent")
	waitTaskStatus(t, st, created.TaskID, task.StatusNeedsVerification)
	if n := executorCount(t, st, "input"); n != 0 {
		t.Fatalf("意图崩溃后仍发送了 %d 次输入", n)
	}
	if n := executorCount(t, st, "start"); n != 0 {
		t.Fatalf("意图崩溃后执行器已经启动: %d", n)
	}
	_, executions, deliveries := taskFacts(t, st, created.TaskID)
	if executions != 1 || deliveries != 0 {
		t.Fatalf("意图崩溃后的账本是 executions %d deliveries %d", executions, deliveries)
	}
}

func TestCrashAfterInputSendDoesNotResend(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "input_send",
	})
	created := acceptTask(t, st, "crash-input")
	waitTaskStatus(t, st, created.TaskID, task.StatusNeedsVerification)
	if n := executorCount(t, st, "input"); n != 1 {
		t.Fatalf("输入发送崩溃后的输入次数是 %d", n)
	}
	_, executions, deliveries := taskFacts(t, st, created.TaskID)
	if executions != 1 || deliveries != 0 {
		t.Fatalf("输入发送崩溃后的账本是 executions %d deliveries %d", executions, deliveries)
	}
}

func TestCrashAfterResultSaveReplaysOnce(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "result_save",
	})
	created := acceptTask(t, st, "crash-save")
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	status, executions, deliveries := taskFacts(t, st, created.TaskID)
	if status == task.StatusNeedsVerification || executions != 1 || deliveries != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("结果保存崩溃后的记录不正确: %s executions %d deliveries %d inputs %d", status, executions, deliveries, executorCount(t, st, "input"))
	}
}

func TestCrashAfterResultAckReplaysWithoutSecondExecution(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "ack",
	})
	created := acceptTask(t, st, "crash-ack")
	st.batond.waitExit(t, 20*time.Second)
	waitDeliveryCount(t, st, created.TaskID, 1)
	sessionID := sessionOf(t, st, created.TaskID)
	before := workerStatus(t, st.dataDir, sessionID)
	if before.ResultDelivered || before.ExecutorInputs != 1 || before.PID <= 0 {
		t.Fatalf("确认前的 Worker 状态不正确: %+v", before)
	}
	restartBatond(t, st)
	waitResultDelivered(t, st.dataDir, sessionID)
	after := workerStatus(t, st.dataDir, sessionID)
	status, executions, deliveries := taskFacts(t, st, created.TaskID)
	if after.PID != before.PID || after.ExecutorInputs != 1 || status != task.StatusCompleted || executions != 1 || deliveries != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("补确认产生了另一次执行: before %+v after %+v status %s executions %d deliveries %d", before, after, status, executions, deliveries)
	}
}

func TestBatondRestartKeepsLivingWorker(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_RESULT_GATE":     gate,
	})
	created := acceptTask(t, st, "living-worker")
	waitGateFile(t, gate)
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	sessionID := sessionOf(t, st, created.TaskID)
	before := workerStatus(t, st.dataDir, sessionID)
	st.batond.stop()
	if err := processAlive(before.PID); err != nil {
		t.Fatalf("batond 退出时 Worker 也退出了: %v", err)
	}
	restartBatond(t, st)
	after := workerStatus(t, st.dataDir, sessionID)
	if after.PID != before.PID || after.ExecutorInputs != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("没有连回原 Worker: before %+v after %+v", before, after)
	}
	releaseGate(t, gate, waitGateFile(t, gate))
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	_, executions, deliveries := taskFacts(t, st, created.TaskID)
	if executions != 1 || deliveries != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("重连后重复执行: executions %d deliveries %d inputs %d", executions, deliveries, executorCount(t, st, "input"))
	}
}

func TestStalePIDDoesNotRerun(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "input_send",
	})
	created := acceptTask(t, st, "stale-pid")
	waitTaskStatus(t, st, created.TaskID, task.StatusNeedsVerification)
	if executorCount(t, st, "input") != 1 {
		t.Fatalf("进入待核实前的输入次数是 %d", executorCount(t, st, "input"))
	}
	sessionID := sessionOf(t, st, created.TaskID)
	st.batond.stop()
	worker := workerStatus(t, st.dataDir, sessionID)
	decoy, _ := startIdleProcess(t, 0)
	setWorkerPID(t, st.dataDir, sessionID, decoy.cmd.Process.Pid)
	stopWorker(worker.PID)
	waitWorkerSocketDown(t, st.dataDir, sessionID)
	restartBatond(t, st)
	status, executions, _ := taskFacts(t, st, created.TaskID)
	if status != task.StatusNeedsVerification || executions != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("旧进程号触发了重跑或改写了待核实: %s executions %d inputs %d", status, executions, executorCount(t, st, "input"))
	}
	if err := processAlive(decoy.cmd.Process.Pid); err != nil {
		t.Fatalf("诱饵进程被当成 Worker 处理了: %v", err)
	}
	if !strings.Contains(st.batond.out.String(), "event=worker_pid_not_proof") {
		t.Fatalf("没有拒绝把进程号当证据: %s", st.batond.out.String())
	}
}

func TestStaleCentralStateDoesNotRerun(t *testing.T) {
	for _, staleStatus := range []string{task.StatusQueued, task.StatusRunning} {
		t.Run(staleStatus, func(t *testing.T) {
			st := startPrepareStack(t, map[string]string{
				"BATON_TEST_HOLD_START":      "0",
				"BATON_TEST_EXECUTOR_SCRIPT": "success",
				"BATON_TEST_CRASH_AFTER":     "input_send",
			})
			created := acceptTask(t, st, "stale-center-"+staleStatus)
			waitTaskStatus(t, st, created.TaskID, task.StatusNeedsVerification)
			waitLog(t, st.batond, "event=execution_report_acked")
			sessionID := sessionOf(t, st, created.TaskID)
			worker := workerStatus(t, st.dataDir, sessionID)
			if !worker.Uncertain || !worker.StartIntent || !worker.InputSubmitted {
				t.Fatalf("节点没有保留输入不确定的账本: %+v", worker)
			}
			if starts, inputs := executorCount(t, st, "start"), executorCount(t, st, "input"); starts != 1 || inputs != 1 {
				t.Fatalf("制造状态不一致前的执行次数不正确: starts %d inputs %d", starts, inputs)
			}
			st.batond.stop()
			stopWorker(worker.PID)
			waitWorkerSocketDown(t, st.dataDir, sessionID)
			path, err := session.LedgerPath(st.dataDir, sessionID)
			if err != nil {
				t.Fatal(err)
			}
			if needs, err := session.LedgerNeedsWorker(path); err != nil || needs {
				t.Fatalf("已确认待核实的账本仍需启动 Worker: needs %v err %v", needs, err)
			}

			var version, events int
			if err := st.pool.QueryRow(context.Background(), `
				SELECT version, (SELECT COUNT(*) FROM task_events WHERE task_id = tasks.id)
				FROM tasks WHERE id = $1::uuid`, created.TaskID).Scan(&version, &events); err != nil {
				t.Fatal(err)
			}
			changed, err := st.pool.Exec(context.Background(), `
				UPDATE tasks SET status = $2 WHERE id = $1::uuid AND status = 'needs_verification'`, created.TaskID, staleStatus)
			if err != nil || changed.RowsAffected() != 1 {
				t.Fatalf("没有制造中心旧状态: %v rows %d", err, changed.RowsAffected())
			}
			if status, executions, deliveries := taskFacts(t, st, created.TaskID); status != staleStatus || executions != 1 || deliveries != 0 {
				t.Fatalf("重启前中心记录不正确: %s executions %d deliveries %d", status, executions, deliveries)
			}

			restartBatond(t, st)
			waitLog(t, st.batond, "event=worker_pid_not_proof")
			waitLog(t, st.batond, "event=connected")
			waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
			for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
				status, executions, deliveries := taskFacts(t, st, created.TaskID)
				starts, inputs := executorCount(t, st, "start"), executorCount(t, st, "input")
				if status != staleStatus || executions != 1 || deliveries != 0 || starts != 1 || inputs != 1 {
					t.Fatalf("中心旧状态触发了重跑或被旧事件改写: %s executions %d deliveries %d starts %d inputs %d\n%s", status, executions, deliveries, starts, inputs, st.batond.out.String())
				}
				time.Sleep(100 * time.Millisecond)
			}
			var afterVersion, afterEvents int
			if err := st.pool.QueryRow(context.Background(), `
				SELECT version, (SELECT COUNT(*) FROM task_events WHERE task_id = tasks.id)
				FROM tasks WHERE id = $1::uuid`, created.TaskID).Scan(&afterVersion, &afterEvents); err != nil {
				t.Fatal(err)
			}
			if afterVersion != version || afterEvents != events {
				t.Fatalf("重启后用事件回写了中心: version %d -> %d events %d -> %d", version, afterVersion, events, afterEvents)
			}
		})
	}
}

func TestCorruptHistoryDoesNotLookLikeRecovery(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "input_send",
	})
	created := acceptTask(t, st, "corrupt-history")
	waitTaskStatus(t, st, created.TaskID, task.StatusNeedsVerification)
	sessionID := sessionOf(t, st, created.TaskID)
	st.batond.stop()
	worker := workerStatus(t, st.dataDir, sessionID)
	stopWorker(worker.PID)
	waitWorkerSocketDown(t, st.dataDir, sessionID)
	path, err := session.LedgerPath(st.dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Rename(path+"-wal", path+"-wal.aside")
	_ = os.Rename(path+"-shm", path+"-shm.aside")
	if err := os.WriteFile(path, []byte("corrupt-ledger"), 0o600); err != nil {
		t.Fatal(err)
	}
	restartBatond(t, st)
	waitLog(t, st.batond, "event=history_unreadable")
	waitTaskCode(t, st, created.TaskID, task.CodeUncertainHistory)
	status, executions, _ := taskFacts(t, st, created.TaskID)
	if status != task.StatusNeedsVerification || executions != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("损坏历史被当成恢复成功: %s executions %d inputs %d log %s", status, executions, executorCount(t, st, "input"), st.batond.out.String())
	}
}

func TestCrashAfterInputIntentDoesNotSendInput(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "input_intent",
	})
	created := acceptTask(t, st, "crash-input-intent")
	waitTaskStatus(t, st, created.TaskID, task.StatusNeedsVerification)
	waitTaskCode(t, st, created.TaskID, task.CodeUncertainInput)
	if executorCount(t, st, "start") != 1 || executorCount(t, st, "input") != 0 {
		t.Fatalf("输入意图崩溃后的执行器日志不正确: start %d input %d", executorCount(t, st, "start"), executorCount(t, st, "input"))
	}
	_, executions, deliveries := taskFacts(t, st, created.TaskID)
	if executions != 1 || deliveries != 0 {
		t.Fatalf("输入意图崩溃后的账本是 executions %d deliveries %d", executions, deliveries)
	}
}

func TestMissingHistoryFromRunningIsReported(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "after_started",
		"BATON_TEST_RESULT_GATE":     t.TempDir(),
	})
	created := acceptTask(t, st, "missing-history")
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	st.batond.waitExit(t, 20*time.Second)
	sessionID := sessionOf(t, st, created.TaskID)
	worker := workerStatus(t, st.dataDir, sessionID)
	st.batond.stop()
	stopWorker(worker.PID)
	waitWorkerSocketDown(t, st.dataDir, sessionID)
	path, err := session.LedgerPath(st.dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".aside"); err != nil {
		t.Fatal(err)
	}
	_ = os.Rename(path+"-wal", path+"-wal.aside")
	_ = os.Rename(path+"-shm", path+"-shm.aside")
	restartBatond(t, st)
	waitTaskCode(t, st, created.TaskID, task.CodeUncertainHistory)
	status, executions, deliveries := taskFacts(t, st, created.TaskID)
	if status != task.StatusNeedsVerification || executions != 1 || deliveries != 0 || executorCount(t, st, "input") != 1 {
		t.Fatalf("缺失历史没有单独记下: %s executions %d deliveries %d inputs %d", status, executions, deliveries, executorCount(t, st, "input"))
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("缺失历史被新建了: %v", err)
	}
}

func TestPersistentHistoryPermissionFailureIsReported(t *testing.T) {
	for _, statDenied := range []bool{false, true} {
		t.Run(fmt.Sprintf("stat_denied=%v", statDenied), func(t *testing.T) {
			st := startPrepareStack(t, map[string]string{
				"BATON_TEST_HOLD_START":      "0",
				"BATON_TEST_EXECUTOR_SCRIPT": "success",
				"BATON_TEST_CRASH_AFTER":     "after_started",
				"BATON_TEST_RESULT_GATE":     t.TempDir(),
			})
			created := acceptTask(t, st, "unread-history")
			waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
			sessionID := sessionOf(t, st, created.TaskID)
			worker := workerStatus(t, st.dataDir, sessionID)
			st.batond.stop()
			stopWorker(worker.PID)
			waitWorkerSocketDown(t, st.dataDir, sessionID)
			path, err := session.LedgerPath(st.dataDir, sessionID)
			if err != nil {
				t.Fatal(err)
			}
			denied, mode := path, os.FileMode(0o600)
			if statDenied {
				denied, mode = filepath.Dir(path), 0o700
			}
			if err := os.Chmod(denied, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(denied, mode) })
			if f, err := os.Open(path); err == nil {
				f.Close()
				t.Skip("当前用户仍能读取无权限文件")
			}
			restartBatond(t, st)
			waitTaskCode(t, st, created.TaskID, task.CodeUncertainHistory)
			waitLog(t, st.batond, "event=history_reported")
			time.Sleep(time.Second)
			before := strings.Count(st.batond.out.String(), "event=history_read_failed")
			if before < 3 || before > 4 || strings.Contains(st.batond.out.String(), "event=history_unreadable") {
				t.Fatalf("权限错误没有走有界读取失败路径: %s", st.batond.out.String())
			}
			time.Sleep(time.Second)
			if after := strings.Count(st.batond.out.String(), "event=history_read_failed"); after != before {
				t.Fatalf("上报后还在无限读取: before %d after %d", before, after)
			}
			status, executions, deliveries := taskFacts(t, st, created.TaskID)
			if status != task.StatusNeedsVerification || executions != 1 || deliveries != 0 ||
				executorCount(t, st, "start") != 1 || executorCount(t, st, "input") != 1 {
				t.Fatalf("不可读历史触发了重跑: %s executions %d deliveries %d", status, executions, deliveries)
			}
			if err := os.Chmod(denied, mode); err != nil {
				t.Fatal(err)
			}
			restartBatond(t, st)
			waitLog(t, st.batond, "event=history_reported")
			waitWorkerSocketDown(t, st.dataDir, sessionID)
			if strings.Contains(st.batond.out.String(), "event=history_read_failed") ||
				strings.Contains(st.batond.out.String(), "event=worker_pid_not_proof") {
				t.Fatalf("重启清空了已耗尽的读取预算: %s", st.batond.out.String())
			}
		})
	}
}

func TestLivingWorkerResultSurvivesMissingLedger(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_CRASH_AFTER":     "after_started",
		"BATON_TEST_RESULT_GATE":     gate,
	})
	created := acceptTask(t, st, "living-result")
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	st.batond.waitExit(t, 20*time.Second)
	sessionID := sessionOf(t, st, created.TaskID)
	worker := workerStatus(t, st.dataDir, sessionID)
	if worker.PID <= 0 {
		t.Fatal("结果还在 Worker 里，进程却不在")
	}
	client := dialWorker(t, st.dataDir, sessionID)
	defer client.Close()
	resultSaved := false
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline) && !resultSaved; {
		pending, err := client.Pending()
		if err != nil {
			t.Fatal(err)
		}
		for _, report := range pending.Reports {
			if report.Kind == protocol.ReportResult {
				resultSaved = true
				break
			}
		}
		if !resultSaved {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if !resultSaved {
		t.Fatal("Worker 结果尚未持久化")
	}
	path, err := session.LedgerPath(st.dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".aside"); err != nil {
		if runtime.GOOS != "windows" || !errors.Is(err, syscall.Errno(32)) {
			t.Fatal(err)
		}
		t.Log("Windows 保持打开账本的文件锁，本用例继续验证原 Worker 的结果交付")
	}
	restartBatond(t, st)
	releaseGate(t, gate, waitGateFile(t, gate))
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	status, executions, deliveries := taskFacts(t, st, created.TaskID)
	code := ""
	_ = st.pool.QueryRow(context.Background(), `SELECT COALESCE(error_code, '') FROM tasks WHERE id = $1::uuid`, created.TaskID).Scan(&code)
	if status != task.StatusCompleted || code == task.CodeUncertainHistory || executions != 1 || deliveries != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("存活 Worker 的结果被降级了: %s %s executions %d deliveries %d inputs %d\n%s", status, code, executions, deliveries, executorCount(t, st, "input"), st.batond.out.String())
	}
}

func TestRelayAndCoordinatorRestartDoNotRerun(t *testing.T) {
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_RESULT_GATE":     gate,
	})
	created := acceptTask(t, st, "restart-center")
	releaseID := waitGateFile(t, gate)
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	sessionID := sessionOf(t, st, created.TaskID)
	before := workerStatus(t, st.dataDir, sessionID)
	restartRelay(t, st)
	restartCoord(t, st)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	after := workerStatus(t, st.dataDir, sessionID)
	status, executions, deliveries := taskFacts(t, st, created.TaskID)
	if after.PID != before.PID || after.ExecutorInputs != 1 || status != task.StatusRunning || executions != 1 || deliveries != 0 || executorCount(t, st, "input") != 1 {
		t.Fatalf("中心组件重启后重复执行: before %+v after %+v status %s executions %d deliveries %d", before, after, status, executions, deliveries)
	}
	releaseGate(t, gate, releaseID)
	waitTaskStatusWithin(t, st, created.TaskID, task.StatusCompleted, 50*time.Second)
	_, executions, deliveries = taskFacts(t, st, created.TaskID)
	if executions != 1 || deliveries != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("重启后的补报不正确: executions %d deliveries %d inputs %d", executions, deliveries, executorCount(t, st, "input"))
	}
}

func TestDatabaseStopReplaysLocalResultOnce(t *testing.T) {
	pg := startPrivatePostgres(t)
	t.Setenv("BATON_TEST_DATABASE_URL", pg.url)
	gate := t.TempDir()
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_HOLD_START":      "0",
		"BATON_TEST_EXECUTOR_SCRIPT": "success",
		"BATON_TEST_RESULT_GATE":     gate,
	})
	created := acceptTask(t, st, "db-stop")
	releaseID := waitGateFile(t, gate)
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	sessionID := sessionOf(t, st, created.TaskID)
	pg.stop(t)
	releaseGate(t, gate, releaseID)
	if waitPostRejected(t, st) {
		t.Fatal("数据库停机时仍然接受了新任务")
	}
	if workerStatus(t, st.dataDir, sessionID).ResultDelivered {
		t.Fatal("数据库停机时把本地结果标成了已交付")
	}
	pg.start(t)
	waitTaskStatus(t, st, created.TaskID, task.StatusCompleted)
	status, executions, deliveries := taskFacts(t, st, created.TaskID)
	var tasks int
	if err := st.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM tasks`).Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if status != task.StatusCompleted || executions != 1 || deliveries != 1 || tasks != 1 || executorCount(t, st, "input") != 1 {
		t.Fatalf("数据库恢复后的记录不正确: %s executions %d deliveries %d tasks %d inputs %d", status, executions, deliveries, tasks, executorCount(t, st, "input"))
	}
	waitResultDelivered(t, st.dataDir, sessionID)
}

func executorCount(t *testing.T, st *prepareStack, line string) int {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(st.dataDir, "executor.log"))
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(raw), line+"\n")
}

func taskFacts(t *testing.T, st *prepareStack, taskID string) (string, int, int) {
	t.Helper()
	var status string
	var executions, deliveries int
	if err := st.pool.QueryRow(context.Background(), `
		SELECT status,
		       (SELECT COUNT(*) FROM executions WHERE task_id = tasks.id),
		       (SELECT COUNT(*) FROM delivery_records WHERE task_id = tasks.id)
		FROM tasks WHERE id = $1::uuid`, taskID).Scan(&status, &executions, &deliveries); err != nil {
		t.Fatal(err)
	}
	return status, executions, deliveries
}

func sessionOf(t *testing.T, st *prepareStack, taskID string) string {
	t.Helper()
	var sessionID string
	if err := st.pool.QueryRow(context.Background(), `SELECT target_session_id::text FROM tasks WHERE id = $1::uuid`, taskID).Scan(&sessionID); err != nil || sessionID == "" {
		t.Fatalf("没有 Session: %v %s", err, sessionID)
	}
	return sessionID
}

func waitTaskCode(t *testing.T, st *prepareStack, taskID, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var code string
	for time.Now().Before(deadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT COALESCE(error_code, '') FROM tasks WHERE id = $1::uuid`, taskID).Scan(&code); err == nil && code == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("任务原因是 %s，想要 %s\ncoord %s\nnode %s", code, want, st.coord.out.String(), st.batond.out.String())
}

func waitDeliveryCount(t *testing.T, st *prepareStack, taskID string, want int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var deliveries int
	for time.Now().Before(deadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM delivery_records WHERE task_id = $1::uuid`, taskID).Scan(&deliveries); err == nil && deliveries == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("交付记录是 %d，想要 %d\ncoord %s\nnode %s", deliveries, want, st.coord.out.String(), st.batond.out.String())
}

func setWorkerPID(t *testing.T, dataDir, sessionID string, pid int) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dataDir, "node.db"))+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	res, err := db.Exec(`UPDATE workers SET pid = ? WHERE session_id = ?`, pid, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	n, err := res.RowsAffected()
	if err != nil || n != 1 {
		t.Fatalf("没有改到 Worker 进程号: %v %d", err, n)
	}
}

func waitWorkerSocketDown(t *testing.T, dataDir, sessionID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		endpoint, err := session.Endpoint(dataDir, sessionID)
		if err != nil {
			t.Fatal(err)
		}
		conn, err := net.DialTimeout("unix", endpoint, 100*time.Millisecond)
		if err != nil {
			return
		}
		conn.Close()
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("Worker 套接字仍然可连接")
}

func waitPostRejected(t *testing.T, st *prepareStack) bool {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		code, _ := postRaw(t, st.client, st.base+"/api/v1/tasks", map[string]any{
			"request_id": "db-down-should-fail", "description": "数据库停机时不能接受",
		}, st.csrf)
		if code != 200 {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
	return true
}

type privatePostgres struct {
	dir  string
	url  string
	port int
	bin  string
	user string
}

func startPrivatePostgres(t *testing.T) *privatePostgres {
	t.Helper()
	bin, user := postgresBinDir(t)
	base := t.TempDir()
	parent := filepath.Dir(base)
	if parent != os.TempDir() {
		if err := os.Chmod(parent, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(base, 0o755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "pg")
	if user != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		account, err := userLookup(user)
		if err != nil {
			t.Skipf("找不到运行数据库的用户 %s: %v", user, err)
		}
		if err := os.Chown(dir, account.uid, account.gid); err != nil {
			t.Fatal(err)
		}
	}
	if err := runPostgres(user, filepath.Join(bin, "initdb"), "-D", dir, "-A", "trust", "--locale=C", "--encoding=UTF8", "--username="+postgresRole(user)); err != nil {
		t.Fatalf("initdb: %v", err)
	}
	hba := "host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n"
	if runtime.GOOS != "windows" {
		hba = "local all all trust\n" + hba
	}
	if err := os.WriteFile(filepath.Join(dir, "pg_hba.conf"), []byte(hba), 0o600); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	role := postgresRole(user)
	hbaPath := filepath.Join(dir, "pg_hba.conf")
	if user != "" {
		account, err := userLookup(user)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(hbaPath, account.uid, account.gid); err != nil {
			t.Fatal(err)
		}
	}
	pg := &privatePostgres{
		dir: dir, port: port, bin: bin, user: user,
		url: fmt.Sprintf("postgres://%s@127.0.0.1:%d/postgres?sslmode=disable", role, port),
	}
	pg.start(t)
	t.Cleanup(func() { pg.stop(t) })
	return pg
}

func (p *privatePostgres) start(t *testing.T) {
	t.Helper()
	options := fmt.Sprintf("-p %d -h 127.0.0.1", p.port)
	if runtime.GOOS != "windows" {
		options += " -k /tmp"
	}
	if err := runPostgresCtl(p.user, p.dir, p.bin, "start", "-w", "-o", options); err != nil {
		t.Fatal(err)
	}
}

func (p *privatePostgres) stop(t *testing.T) {
	t.Helper()
	err := runPostgresCtl(p.user, p.dir, p.bin, "stop", "-m", "fast", "-w")
	if err != nil && !strings.Contains(err.Error(), "no server running") {
		t.Fatal(err)
	}
}

func postgresBinDir(t *testing.T) (string, string) {
	t.Helper()
	bin := strings.TrimSpace(os.Getenv("BATON_TEST_POSTGRES_BINDIR"))
	if bin == "" {
		pgConfig, err := exec.LookPath("pg_config")
		if err != nil {
			t.Skip("没有 pg_config，也没有 BATON_TEST_POSTGRES_BINDIR，跳过独立数据库停机测试")
		}
		out, err := exec.Command(pgConfig, "--bindir").Output()
		if err != nil {
			t.Skipf("pg_config --bindir 失败: %v", err)
		}
		bin = strings.TrimSpace(string(out))
	}
	if _, err := exec.LookPath(filepath.Join(bin, "initdb")); err != nil {
		t.Skipf("找不到 initdb（%s），跳过独立数据库停机测试", bin)
	}
	if os.Geteuid() != 0 {
		return bin, ""
	}
	if _, err := exec.LookPath("runuser"); err != nil {
		t.Skip("当前是 root，且没有 runuser，跳过独立数据库停机测试")
	}
	if _, err := user.Lookup("postgres"); err != nil {
		t.Skip("当前是 root，且没有 postgres 用户，跳过独立数据库停机测试")
	}
	return bin, "postgres"
}

func postgresRole(runAs string) string {
	if runAs != "" {
		return runAs
	}
	if runtime.GOOS == "windows" {
		return "postgres"
	}
	current, err := user.Current()
	if err != nil || current.Username == "" {
		return "postgres"
	}
	return current.Username
}

type systemAccount struct {
	uid int
	gid int
}

func userLookup(name string) (systemAccount, error) {
	account, err := user.Lookup(name)
	if err != nil {
		return systemAccount{}, err
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return systemAccount{}, err
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return systemAccount{}, err
	}
	return systemAccount{uid: uid, gid: gid}, nil
}

func runPostgres(runAs, bin string, args ...string) error {
	var cmd *exec.Cmd
	if runAs == "" {
		cmd = exec.Command(bin, args...)
	} else {
		cmd = exec.Command("runuser", append([]string{"-u", runAs, "--", bin}, args...)...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v %s", filepath.Base(bin), err, out)
	}
	return nil
}

func runPostgresCtl(runAs, dir, bin, action string, args ...string) error {
	logFile, err := os.OpenFile(filepath.Join(dir, "ctl.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer logFile.Close()
	if runAs != "" {
		if account, err := userLookup(runAs); err == nil {
			_ = os.Chown(logFile.Name(), account.uid, account.gid)
		}
	}
	argv := []string{"-D", dir, "-l", filepath.Join(dir, "server.log"), action}
	argv = append(argv, args...)
	var cmd *exec.Cmd
	if runAs == "" {
		cmd = exec.Command(filepath.Join(bin, "pg_ctl"), argv...)
	} else {
		cmd = exec.Command("runuser", append([]string{"-u", runAs, "--", filepath.Join(bin, "pg_ctl")}, argv...)...)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Run(); err != nil {
		logged, _ := os.ReadFile(filepath.Join(dir, "ctl.log"))
		server, _ := os.ReadFile(filepath.Join(dir, "server.log"))
		return fmt.Errorf("pg_ctl %s: %v %s %s", action, err, logged, server)
	}
	return nil
}

func waitTaskStatusWithin(t *testing.T, st *prepareStack, taskID, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var status string
	for time.Now().Before(deadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT status FROM tasks WHERE id = $1::uuid`, taskID).Scan(&status); err == nil && status == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("任务状态是 %s，想要 %s\ncoord %s\nnode %s", status, want, st.coord.out.String(), st.batond.out.String())
}

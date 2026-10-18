package session

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/startpermit"
	"baton/internal/task"
)

func TestExecutionClockIgnoresWallJumpsAndIncludesSuspend(t *testing.T) {
	w, clock, sessionID := clockWorker(t, 1)
	clock.JumpWall(24 * time.Hour)
	clock.Advance(999 * time.Millisecond)
	if err := w.checkDeadline(sessionID); err != nil || w.cancelled {
		t.Fatalf("墙钟误触发到期: %v", err)
	}
	clock.JumpWall(-48 * time.Hour)
	clock.Suspend(time.Millisecond)
	if err := w.checkDeadline(sessionID); err != nil || !w.cancelled {
		t.Fatalf("休眠未计入执行预算: %v", err)
	}
	reps, err := w.SubmitInput(sessionID, `{"description":"不得补发"}`)
	if err != nil || w.observer.Inputs() != 0 {
		t.Fatalf("到期后输入被送出: %v", err)
	}
	stop := findStop(t, reps)
	if stop.StopReason != task.CodeExecutionTimeout || !stop.NotStarted || !stop.AgentStopped || !stop.OutcomeKnown {
		t.Fatalf("未发送事实不正确: %+v", stop)
	}
}

func TestInputDispatchDelayIsDurableMonotonicEvidence(t *testing.T) {
	w, clock, sessionID := clockWorker(t, 30)
	due := clock.Wall()
	clock.JumpWall(-24 * time.Hour)
	clock.Advance(1500 * time.Millisecond)
	if _, err := w.SubmitInput(sessionID, `{"description":"延迟输入"}`); err != nil {
		t.Fatal(err)
	}
	var payload string
	if err := w.db.QueryRow(`SELECT body FROM execution_log WHERE kind = 'input_dispatch'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var ev struct {
		DueAt   time.Time `json:"due_at"`
		SentAt  time.Time `json:"sent_at"`
		DelayMS int64     `json:"delay_ms"`
	}
	if err := json.Unmarshal([]byte(payload), &ev); err != nil || ev.DelayMS != 1500 || !ev.DueAt.Equal(due) || !ev.SentAt.Equal(clock.Wall()) {
		t.Fatalf("补发延迟未持久化或使用了墙钟差: %s %v", payload, err)
	}
	clock.Suspend(29 * time.Second)
	if err := w.checkDeadline(sessionID); err != nil {
		t.Fatal(err)
	}
	reps, err := w.Pending()
	if err != nil {
		t.Fatal(err)
	}
	stop := findStop(t, reps)
	if stop.NotStarted || !stop.AgentStopped || !stop.OutcomeKnown {
		t.Fatalf("运行中到期事实: %+v", stop)
	}
	if _, err := w.SubmitInput(sessionID, "不准重发"); err != nil || w.observer.Inputs() != 1 {
		t.Fatalf("重放了输入: %v", err)
	}
}

func TestWorkerStopAndInputShareIPCSerialization(t *testing.T) {
	for _, script := range []string{"running", "success"} {
		t.Run(script, func(t *testing.T) {
			t.Setenv("BATON_TEST_EXECUTOR_SCRIPT", script)
			client, pub, priv, taskID, execID, dir := startBoundWorker(t)
			defer client.Close()
			nonce := armNonce(t, client, taskID, execID)
			generation := mustSessionID(t)
			queue := time.Now().UTC().Add(time.Minute).Truncate(time.Millisecond)
			permit := signPermit(t, priv, taskID, execID, generation, nonce, queue, startpermit.PermitTTL)
			if _, err := client.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue.Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			st, err := client.Status()
			if err != nil {
				t.Fatal(err)
			}
			endpoint, _ := Endpoint(dir, st.SessionID)
			token, _ := readToken(dir, st.SessionID)
			other := waitClient(t, endpoint, token)
			defer other.Close()
			gate := make(chan struct{})
			var wg sync.WaitGroup
			var inputErr, stopErr error
			wg.Add(2)
			go func() { defer wg.Done(); <-gate; _, inputErr = client.SubmitInput(`{"description":"竞态输入"}`) }()
			go func() { defer wg.Done(); <-gate; _, stopErr = other.Stop(task.StatusCancelled) }()
			close(gate)
			wg.Wait()
			if inputErr != nil || stopErr != nil {
				t.Fatalf("IPC 竞态: %v %v", inputErr, stopErr)
			}
			final, err := client.Pending()
			if err != nil || !final.Cancelled || final.ExecutorInputs > 1 || !final.StartIntent {
				t.Fatalf("串行化丢失事实: %+v %v", final, err)
			}
			stop := findStopReports(t, final.Reports)
			if stop.NotStarted != (final.ExecutorInputs == 0) || !stop.AgentStopped || !stop.OutcomeKnown {
				t.Fatalf("错误停止证据: %+v", stop)
			}
			for _, r := range final.Reports {
				var body protocol.ExecutionReport
				if err := json.Unmarshal(r.Body, &body); err != nil {
					t.Fatal(err)
				}
				if r.Kind == protocol.ReportResult && body.WorkerSequence >= stop.WorkerSequence {
					t.Fatal("本地完成与中止次序丢失")
				}
			}
			if again, err := client.SubmitInput("禁止补发"); err != nil || again.ExecutorInputs != final.ExecutorInputs {
				t.Fatalf("取消后补发: %+v %v", again, err)
			}
		})
	}
}

func TestStopEvidenceDoesNotInventConfirmation(t *testing.T) {
	for _, script := range []string{"unconfirmed", "unknown"} {
		t.Run(script, func(t *testing.T) {
			t.Setenv("BATON_TEST_ABORT_SCRIPT", script)
			w, _, sessionID := clockWorker(t, 30)
			if _, err := w.SubmitInput(sessionID, `{"description":"运行"}`); err != nil {
				t.Fatal(err)
			}
			reps, err := w.Stop(sessionID, task.StatusCancelled)
			if err != nil {
				t.Fatal(err)
			}
			stop := findStop(t, reps)
			if stop.OutcomeKnown || stop.NotStarted || stop.AgentStopped != (script == "unknown") {
				t.Fatalf("伪造停止/操作结果: %+v", stop)
			}
			replay, err := w.Stop(sessionID, task.StatusCancelled)
			if err != nil || findStop(t, replay).EventID != stop.EventID {
				t.Fatalf("中止未幂等: %v", err)
			}
		})
	}
}

func TestQueueDeadlineDoesNotStopAnAlreadyExecutingTask(t *testing.T) {
	w, clock, sessionID := clockWorker(t, 120)
	if _, err := w.SubmitInput(sessionID, `{"description":"执行"}`); err != nil {
		t.Fatal(err)
	}
	clock.Suspend(60 * time.Second)
	if err := w.checkDeadline(sessionID); err != nil || w.cancelled {
		t.Fatalf("排队期限中断执行中任务: %v", err)
	}
	if _, err := w.Stop(sessionID, task.CodeQueueTimeout); err != nil || w.cancelled {
		t.Fatalf("延迟排队命令中断执行中任务: %v", err)
	}
}

func TestLocalQueueDeadlineRejectsDelayedInput(t *testing.T) {
	w, clock, sessionID := clockWorker(t, 120)
	clock.Suspend(60 * time.Second)
	reps, err := w.SubmitInput(sessionID, "不可补发")
	if err != nil || w.observer.Inputs() != 0 {
		t.Fatalf("排队到期后发送输入: %v", err)
	}
	if stop := findStop(t, reps); stop.StopReason != task.CodeQueueTimeout || !stop.NotStarted {
		t.Fatalf("到期事实错误: %+v", stop)
	}
}

func clockWorker(t *testing.T, seconds int) (*workerDB, *startpermit.Manual, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "worker.db")
	if err := CreateLedger(path); err != nil {
		t.Fatal(err)
	}
	w, err := openWorkerDB(path, NewObserver(""))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	sessionID, taskID, execID := mustSessionID(t), mustSessionID(t), mustSessionID(t)
	if err := w.recover(sessionID); err != nil {
		t.Fatal(err)
	}
	if err := w.Bind(taskID, execID, "pi"); err != nil {
		t.Fatal(err)
	}
	nonce, err := w.Arm(taskID, execID)
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	queue := now.Add(time.Minute)
	generation := mustSessionID(t)
	permit, err := startpermit.Sign(priv, startpermit.Claims{NodeID: mustSessionID(t), EmployeeID: mustSessionID(t), TaskID: taskID, ExecutionID: execID, StorageGeneration: generation, Nonce: nonce, RequestHash: make([]byte, 32), QueueExpiresAt: queue, IssuedAt: now, ExpiresAt: now.Add(startpermit.PermitTTL), ExecutionTimeoutSeconds: seconds})
	if err != nil {
		t.Fatal(err)
	}
	clock := startpermit.NewManual(now)
	w.executionClock = clock
	if started, refused, code, err := w.Authorize(taskID, execID, permit, base64.RawURLEncoding.EncodeToString(pub), generation, queue); err != nil || !started || refused {
		t.Fatalf("授权: %s %v", code, err)
	}
	return w, clock, sessionID
}

func findStop(t *testing.T, reports []ipcReport) protocol.ExecutionReport {
	t.Helper()
	for _, r := range reports {
		if r.Kind == task.EventStopReport {
			var body protocol.ExecutionReport
			if err := json.Unmarshal(r.Body, &body); err != nil {
				t.Fatal(err)
			}
			return body
		}
	}
	t.Fatal("缺少停止回执")
	return protocol.ExecutionReport{}
}

func findStopReports(t *testing.T, reports []Report) protocol.ExecutionReport {
	t.Helper()
	for _, r := range reports {
		if r.Kind == task.EventStopReport {
			var body protocol.ExecutionReport
			if err := json.Unmarshal(r.Body, &body); err != nil {
				t.Fatal(err)
			}
			return body
		}
	}
	t.Fatal("缺少 IPC 停止回执")
	return protocol.ExecutionReport{}
}

package node

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
	"encoding/json"
)

func TestProjectCleanupUnknownRecovery(t *testing.T) {
	ledger, err := OpenLedger(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	var commands []protocol.ProjectRunCommand
	for _, state := range []string{"starting", "running", "exited", "failed"} {
		command := projectCommand()
		commands = append(commands, command)
		if _, err := ledger.db.Exec(`INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,?)`, command.RunID, command.LeaseEpoch, state); err != nil {
			t.Fatal(err)
		}
	}
	m, err := newProjectRuntimeManager(context.Background(), ledger)
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	for i, state := range []string{"starting", "running", "exited", "failed"} {
		command := commands[i]
		command.Type = protocol.BodyProjectRunStop
		m.command(command)
		command.Type = protocol.BodyProjectRunStart
		m.command(command)
		var got string
		var complete, acked, attempts int
		if err := ledger.db.QueryRow(`SELECT state,cleanup_complete,cleanup_acked,cleanup_attempts FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&got, &complete, &acked, &attempts); err != nil {
			t.Fatal(err)
		}
		if got != state || complete != 0 || acked != 0 || attempts != 0 || len(m.runs) != 0 {
			t.Fatalf("restart invented cleanup evidence for %s: %s %d %d %d", state, got, complete, acked, attempts)
		}
	}
	if _, err := claimProjectCleanup(context.Background(), ledger.db, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("unproved cleanup was eligible for delivery: %v", err)
	}
}

func TestProjectCleanupTombstoneBeforeAckPreventsLateStart(t *testing.T) {
	m := receiptManager(t, "")
	command := projectCommand()
	command.Type = protocol.BodyProjectRunStop
	m.command(command)
	for range 3 {
		command.Type = protocol.BodyProjectRunStart
		m.command(command)
		command.Type = protocol.BodyProjectRunStop
		m.command(command)
	}
	var state string
	var epoch int64
	var complete, acked int
	if err := m.ledger.db.QueryRow(`SELECT lease_epoch,state,cleanup_complete,cleanup_acked FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&epoch, &state, &complete, &acked); err != nil {
		t.Fatal(err)
	}
	if epoch != command.LeaseEpoch || state != "exited" || complete != 1 || acked != 0 || len(m.runs) != 0 {
		t.Fatal("unknown stop was not durably fenced before confirmation")
	}
	command.LeaseEpoch++
	m.command(command)
	if err := m.ledger.db.QueryRow(`SELECT lease_epoch FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&epoch); err != nil || epoch != command.LeaseEpoch-1 {
		t.Fatal("wrong epoch replaced tombstone")
	}
}

func TestProjectCleanupRetryPersistsAcrossRestart(t *testing.T) {
	m := receiptManager(t, "")
	command := projectCommand()
	var stops atomic.Int32
	requests := receiptConnection(t, m, func(_ context.Context, req protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		if req.Operation == "exited" {
			return protocol.ProjectRuntimeResult{Code: "lease_lost"}, true
		}
		stops.Add(1)
		return protocol.ProjectRuntimeResult{Code: "unavailable"}, true
	})
	command.Type = protocol.BodyProjectRunStop
	before := time.Now()
	m.command(command)
	waitProjectRequest(t, requests, "exited")
	waitProjectRequest(t, requests, "stopped")
	awaitReceiptCondition(t, func() bool { return stops.Load() == 1 })
	m.close()
	var complete, acked, attempts int
	var next int64
	if err := m.ledger.db.QueryRow(`SELECT cleanup_complete,cleanup_acked,cleanup_attempts,cleanup_next_at FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&complete, &acked, &attempts, &next); err != nil {
		t.Fatal(err)
	}
	if complete != 1 || acked != 0 || attempts != 1 || next < before.Add(6*time.Second).UnixMilli() {
		t.Fatalf("failed stopped lost retry state or RPC reservation: %d %d %d %d", complete, acked, attempts, next)
	}
	dir := m.ledger.dir
	m.ledger.Close()
	recovered := receiptManager(t, dir)
	requests = receiptConnection(t, recovered, func(_ context.Context, req protocol.ProjectRuntimeRequest) (protocol.ProjectRuntimeResult, bool) {
		// 网络调用期间本地连接和管理锁都必须可用。
		recovered.mu.Lock()
		recovered.mu.Unlock()
		if _, err := recovered.ledger.db.Exec(`UPDATE project_runtime_runs SET reason=reason WHERE run_id=?`, req.RunID); err != nil {
			t.Error(err)
		}
		if req.Operation == "exited" {
			return protocol.ProjectRuntimeResult{Code: "lease_lost"}, true
		}
		return protocol.ProjectRuntimeResult{OK: true}, true
	})
	if _, err := claimProjectCleanup(context.Background(), recovered.ledger.db, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("restart discarded persisted due time: %v", err)
	}
	if _, err := recovered.ledger.db.Exec(`UPDATE project_runtime_runs SET cleanup_next_at=0 WHERE run_id=?`, command.RunID); err != nil {
		t.Fatal(err)
	}
	recovered.signalCleanup()
	first := waitProjectRequest(t, requests, "exited")
	second := waitProjectRequest(t, requests, "stopped")
	if first.RunID != command.RunID || second.RunID != command.RunID || second.LeaseEpoch != command.LeaseEpoch {
		t.Fatal("retry changed run identity")
	}
	awaitReceiptCondition(t, func() bool {
		_ = recovered.ledger.db.QueryRow(`SELECT cleanup_acked,cleanup_attempts FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&acked, &attempts)
		return acked == 1
	})
	if attempts != 2 {
		t.Fatalf("unexpected attempts: %d", attempts)
	}
}

func TestProjectCleanupSQLiteFailureRetainsBoundedProof(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Runtime Unix IPC 夹具；Windows 平台验证由父任务执行")
	}
	var reject atomic.Bool
	reject.Store(true)
	m, requests, log := projectRuntimeFixture(t, func(req protocol.ProjectRuntimeRequest) {
		if reject.Load() && (req.Operation == "exited" || req.Operation == "stopped") {
			t.Error("cleanup receipt sent before cleanup fact could be saved")
		}
	})
	if _, err := m.ledger.db.Exec(`CREATE TRIGGER reject_cleanup BEFORE UPDATE OF cleanup_complete ON project_runtime_runs WHEN NEW.cleanup_complete=1 BEGIN SELECT RAISE(ABORT,'cleanup temporarily unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		command := projectCommand()
		sendProjectCommand(m, command)
		waitProjectRequest(t, requests, "bootstrap")
		m.mu.Lock()
		p := m.runs[command.RunID]
		m.mu.Unlock()
		command.Type = protocol.BodyProjectRunStop
		sendProjectCommand(m, command)
		select {
		case <-p.finished:
		case <-time.After(3 * time.Second):
			t.Fatal("process cleanup did not finish after SQLite rejection")
		}
		m.mu.Lock()
		retained := m.runs[command.RunID] == p && p.cleanupPending
		m.mu.Unlock()
		if !retained {
			t.Fatal("failed SQLite write dropped the only cleanup proof")
		}
		// 已结束但尚未落账的身份同样禁止重复启动。
		command.Type = protocol.BodyProjectRunStart
		m.command(command)
	}
	fifth := projectCommand()
	sendProjectCommand(m, fifth)
	failed := waitProjectRequest(t, requests, "start_failed")
	if failed.RunID != fifth.RunID || failed.Reason != "capacity_exceeded" {
		t.Fatalf("pending cleanup proofs escaped the four-run bound: %+v", failed)
	}
	var complete, acked int
	if err := m.ledger.db.QueryRow(`SELECT SUM(cleanup_complete),SUM(cleanup_acked) FROM project_runtime_runs`).Scan(&complete, &acked); err != nil || complete != 0 || acked != 0 {
		t.Fatalf("failed SQLite write produced confirmation: complete=%d acked=%d err=%v", complete, acked, err)
	}
	reject.Store(false)
	if _, err := m.ledger.db.Exec(`DROP TRIGGER reject_cleanup`); err != nil {
		t.Fatal(err)
	}
	// 固定循环自行重试，不依赖中心再发 stop。
	awaitReceiptCondition(t, func() bool {
		_ = m.ledger.db.QueryRow(`SELECT SUM(cleanup_complete),SUM(cleanup_acked) FROM project_runtime_runs`).Scan(&complete, &acked)
		return complete == 4 && acked == 4
	})
	m.mu.Lock()
	n := len(m.runs)
	m.mu.Unlock()
	if n != 0 {
		t.Fatalf("saved proofs still consume process slots: %d", n)
	}
	raw, err := os.ReadFile(log)
	if err != nil || strings.Count(string(raw), "\n") != 4 {
		t.Fatalf("duplicate start launched another process: %s %v", raw, err)
	}
}

func TestProjectCleanupExitedFailureAndSharedRPCDeadline(t *testing.T) {
	for _, tc := range []struct {
		code      string
		stoppedOK bool
		want      []string
		delivered bool
	}{
		{"unavailable", true, []string{"exited"}, false},
		{"forbidden", true, []string{"exited"}, false},
		{"lease_lost", false, []string{"exited", "stopped"}, false},
		{"lease_lost", true, []string{"exited", "stopped"}, true},
		{"", true, []string{"exited", "stopped"}, true},
	} {
		t.Run(tc.code+"/"+map[bool]string{true: "ok", false: "failed"}[tc.stoppedOK], func(t *testing.T) {
			var operations []string
			var deadline time.Time
			delivered := sendProjectCleanup(context.Background(), projectCleanupReceipt{command: projectCommand()}, func(ctx context.Context, req protocol.ProjectRuntimeRequest) protocol.ProjectRuntimeResult {
				got, ok := ctx.Deadline()
				if !ok || time.Until(got) > projectReceiptTimeout || !deadline.IsZero() && got != deadline {
					t.Fatal("receipt calls did not share one bounded deadline")
				}
				deadline = got
				operations = append(operations, req.Operation)
				if req.Operation == "exited" {
					return protocol.ProjectRuntimeResult{OK: tc.code == "", Code: tc.code}
				}
				return protocol.ProjectRuntimeResult{OK: tc.stoppedOK}
			})
			if delivered != tc.delivered || !reflect.DeepEqual(operations, tc.want) {
				t.Fatalf("delivery=%v, calls=%v", delivered, operations)
			}
		})
	}
}

func TestProjectCleanupActiveStopBarrierAndConcurrentClose(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("本机 Unix IPC 清理屏障；Windows 进程测试覆盖平台停止")
	}
	callEntered, replyRelease := make(chan struct{}), make(chan struct{})
	defer close(replyRelease)
	m, requests, _ := projectRuntimeFixture(t, func(req protocol.ProjectRuntimeRequest) {
		if req.Operation == "call_tool" {
			close(callEntered)
			<-replyRelease
		}
	})
	command := projectCommand()
	sendProjectCommand(m, command)
	waitProjectRequest(t, requests, "bootstrap")
	m.mu.Lock()
	p := m.runs[command.RunID]
	m.mu.Unlock()
	endpoint, err := session.Endpoint(m.ledger.dir, command.RunID)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := session.DialLocal(context.Background(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := json.NewEncoder(conn).Encode(map[string]any{"token": p.token, "request": protocol.ProjectRuntimeRequest{Operation: "call_tool", ToolCallID: "blocked"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-callEntered:
	case <-time.After(time.Second):
		t.Fatal("IPC call did not reach center")
	}
	// IPC 调用的返回路径仍需更新 Thread 缓存；持锁可在 Process.Wait 后暂停本地收尾。
	p.threadMu.Lock()
	locked := true
	defer func() {
		if locked {
			p.threadMu.Unlock()
		}
	}()
	command.Type = protocol.BodyProjectRunStop
	sendProjectCommand(m, command)
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		t.Fatal("process tree did not stop")
	}
	select {
	case <-p.finished:
		t.Fatal("Process.Wait alone bypassed the IPC cleanup barrier")
	default:
	}
	var complete int
	if err := m.ledger.db.QueryRow(`SELECT cleanup_complete FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&complete); err != nil || complete != 0 {
		t.Fatalf("cleanup was saved before IPC returned: %d %v", complete, err)
	}
	closed := make(chan struct{})
	go func() { m.close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("close returned with unfinished local cleanup")
	default:
	}
	p.threadMu.Unlock()
	locked = false
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("active stop and close deadlocked")
	}
	select {
	case <-p.finished:
	default:
		t.Fatal("close did not join full run cleanup")
	}
	if err := m.ledger.db.QueryRow(`SELECT cleanup_complete FROM project_runtime_runs WHERE run_id=?`, command.RunID).Scan(&complete); err != nil || complete != 1 {
		t.Fatalf("completed cleanup was not durable: %d %v", complete, err)
	}
	entries, err := os.ReadDir(filepath.Join(m.ledger.dir, "project-runtimes"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("control directory cleanup not joined: %v %v", entries, err)
	}
}

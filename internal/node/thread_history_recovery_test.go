package node

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/session"
)

type historyFailureHost struct {
	*threadTestHost
	pendingCalls int
	failure      error
}

func (h *historyFailureHost) ThreadPending(ctx context.Context, id string, from int64) ([]protocol.ThreadReport, error) {
	h.pendingCalls++
	if h.failure != nil {
		return nil, h.failure
	}
	return h.threadTestHost.ThreadPending(ctx, id, from)
}
func historyFailureService(t *testing.T) (*threadService, *historyFailureHost, protocol.ThreadCommand) {
	t.Helper()
	s, h, cmd := threadTestService(t)
	if result, err := s.command(t.Context(), threadUUID(t), cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	host := &historyFailureHost{threadTestHost: h}
	s.host = host
	return s, host, cmd
}

func TestThreadHistoryLossPersistsWithoutStartingEmptyWorker(t *testing.T) {
	for _, damage := range []string{"missing", "corrupt"} {
		t.Run(damage, func(t *testing.T) {
			s, _, cmd := historyFailureService(t)
			host := &session.Host{DataDir: s.ledger.dir}
			s.host = newSessionThreadHost(host, s.ledger, threadUUID(t))
			path, err := session.ThreadLedgerPath(s.ledger.dir, cmd.ThreadID)
			if err != nil {
				t.Fatal(err)
			}
			if damage == "corrupt" {
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("invalid SQLite"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			reports, err := s.pending(t.Context(), cmd.ThreadID, 1)
			if err != nil || len(reports) != 1 || reports[0].Kind != "thread.stopped" || !reports[0].HistoryUnavailable {
				t.Fatal(reports, err)
			}
			original := reports[0]
			if err := s.ledger.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenLedger(s.ledger.dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			s.ledger = reopened
			reports, err = s.pending(t.Context(), cmd.ThreadID, 1)
			if err != nil || len(reports) != 1 || reports[0].EventID != original.EventID || reports[0].WorkerSeq != original.WorkerSeq {
				t.Fatal(reports, err)
			}
			record, err := reopened.Thread(t.Context(), cmd.ThreadID)
			if err != nil || record.Status != "history_missing" {
				t.Fatal(record, err)
			}
			raw, err := os.ReadFile(path)
			if damage == "missing" && !errors.Is(err, os.ErrNotExist) {
				t.Fatal("created empty history", err)
			}
			if damage == "corrupt" && (err != nil || string(raw) != "invalid SQLite") {
				t.Fatal("replaced corrupt history", err)
			}
		})
	}
}

func TestThreadHistoryUnreadRecoversAfterRepeatedFailuresAndReconnect(t *testing.T) {
	s, h, open := historyFailureService(t)
	original, err := s.pending(t.Context(), open.ThreadID, 1)
	if err != nil || len(original) != 1 {
		t.Fatal(original, err)
	}
	h.failure = session.ErrHistoryUnread
	for attempt := range 10 {
		if attempt == 4 {
			dir := s.ledger.dir
			if err := s.ledger.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenLedger(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			h.ledger = reopened
			s = newThreadService(reopened, h, 0, func(context.Context, string, any) error { return nil })
		}
		s.historyRetry[open.ThreadID] = time.Now().Add(-time.Second)
		reports, err := s.pending(t.Context(), open.ThreadID, 1)
		if err != nil || !reflect.DeepEqual(reports, original) {
			t.Fatal("暂时读取失败改变了原报告", reports, err)
		}
		calls := h.pendingCalls
		for range 20 {
			if _, err := s.pending(t.Context(), open.ThreadID, 1); err != nil {
				t.Fatal(err)
			}
		}
		if h.pendingCalls != calls {
			t.Fatal("读取失败未限频", h.pendingCalls, calls)
		}
		record, err := s.ledger.Thread(t.Context(), open.ThreadID)
		if err != nil || record.Status != "ready" {
			t.Fatal(record, err)
		}
		if local, err := s.ledger.nodeThreadPending(t.Context(), open.ThreadID, 1); err != nil || len(local) != 0 {
			t.Fatal("暂时读取失败生成了恢复报告", local, err)
		}
	}
	h.threadTestHost.fail = session.ErrHistoryUnread
	commands := make(map[string]protocol.ThreadCommand)
	for _, action := range []string{"message", "stop", "withdraw"} {
		cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: open.ThreadID, Action: action, StorageGeneration: s.ledger.Generation(), ClientMessageID: threadUUID(t), Content: "恢复后继续原会话"}
		id := threadUUID(t)
		commands[id] = cmd
		if _, err := s.command(t.Context(), id, cmd); !errors.Is(err, session.ErrHistoryUnread) {
			t.Fatal(action, err)
		}
		if _, found, err := s.ledger.threadReceipt(t.Context(), id, cmd); err != nil || found {
			t.Fatal("暂时错误被保存为永久拒绝", found, err)
		}
	}
	h.failure, h.threadTestHost.fail = nil, nil
	s.historyRetry[open.ThreadID] = time.Now().Add(-time.Second)
	reports, err := s.pending(t.Context(), open.ThreadID, 1)
	if err != nil || !reflect.DeepEqual(reports, original) {
		t.Fatal(reports, err)
	}
	if _, waiting := s.historyRetry[open.ThreadID]; waiting {
		t.Fatal("读取恢复后仍保留重试状态")
	}
	for id, cmd := range commands {
		for range 2 {
			result, err := s.command(t.Context(), id, cmd)
			if err != nil || !result.OK {
				t.Fatal(cmd.Action, result, err)
			}
		}
	}
	h.append(open.ThreadID, "reply", "")
	reports, err = s.pending(t.Context(), open.ThreadID, 1)
	if err != nil || len(reports) != 2 || reports[0].EventID != original[0].EventID || reports[1].WorkerSeq != 2 || reports[1].HistoryUnavailable {
		t.Fatal("恢复后改变了原Worker序列", reports, err)
	}
	for _, r := range reports {
		if err := s.reportResult(t.Context(), protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: r.ThreadID, EventID: r.EventID, WorkerSeq: r.WorkerSeq, OK: true}); err != nil {
			t.Fatal(err)
		}
	}
	reports, err = s.pending(t.Context(), open.ThreadID, 1)
	if err != nil || len(reports) != 0 {
		t.Fatal("已确认报告仍重复补报", reports, err)
	}
	if h.count("open") != 1 || h.count("message") != 1 || h.count("stop") != 1 || h.count("withdraw") != 1 {
		t.Fatal("读取恢复后重复执行命令", h.calls)
	}
}

func TestThreadHistoryIsolationRejectsCommandsWithoutChangingFacts(t *testing.T) {
	for _, failure := range []struct {
		name               string
		err                error
		code, status, kind string
		attempts           int
	}{
		{"missing", session.ErrHistoryMissing, "history_missing", "history_missing", "thread.stopped", 1},
		{"corrupt", session.ErrHistoryIncompatible, "history_missing", "history_missing", "thread.stopped", 1},
	} {
		t.Run(failure.name, func(t *testing.T) {
			s, h, open := historyFailureService(t)
			h.failure = failure.err
			for range failure.attempts {
				if _, err := s.pending(t.Context(), open.ThreadID, 1); err != nil {
					t.Fatal(err)
				}
			}
			original, err := s.pending(t.Context(), open.ThreadID, 1)
			if err != nil || len(original) != 1 || original[0].Kind != failure.kind {
				t.Fatal(original, err)
			}
			h.failure = nil
			for _, action := range []string{"message", "stop", "withdraw", "open"} {
				for _, generation := range []string{s.ledger.Generation(), threadUUID(t)} {
					cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: open.ThreadID, Action: action, StorageGeneration: generation, ClientMessageID: threadUUID(t), Content: "继续原会话"}
					if action == "open" {
						cmd.AgentType, cmd.WorkingDirectory = open.AgentType, open.WorkingDirectory
					}
					id := threadUUID(t)
					result, err := s.command(t.Context(), id, cmd)
					if err != nil || result.OK || result.Code != failure.code {
						t.Fatal(action, result, err)
					}
					repeated, err := s.command(t.Context(), id, cmd)
					if err != nil || repeated != result {
						t.Fatal("拒绝回执未保持幂等", repeated, err)
					}
				}
			}
			record, err := s.ledger.Thread(t.Context(), open.ThreadID)
			if err != nil || record.Status != failure.status {
				t.Fatal(record, err)
			}
			reports, err := s.pending(t.Context(), open.ThreadID, 1)
			if err != nil || !reflect.DeepEqual(reports, original) {
				t.Fatal("命令拒绝改变了已有恢复事实", reports, err)
			}
			if h.count("message") != 0 || h.count("stop") != 0 || h.count("withdraw") != 0 || h.count("open") != 1 {
				t.Fatal("隔离命令进入了Worker")
			}
			if h.pendingCalls != failure.attempts {
				t.Fatal("隔离命令重新启动了自动恢复", h.pendingCalls)
			}
		})
	}
}

func TestThreadTransientHistoryReadFailureResets(t *testing.T) {
	s, h, cmd := historyFailureService(t)
	for range 2 {
		h.failure = session.ErrHistoryUnread
		if _, err := s.pending(t.Context(), cmd.ThreadID, 1); err != nil {
			t.Fatal(err)
		}
		h.failure = nil
		s.historyRetry[cmd.ThreadID] = time.Now().Add(-time.Second)
		reports, err := s.pending(t.Context(), cmd.ThreadID, 1)
		if err != nil || len(reports) != 1 || reports[0].Kind != "thread.opened" {
			t.Fatal(reports, err)
		}
		if _, waiting := s.historyRetry[cmd.ThreadID]; waiting {
			t.Fatal("成功读取没有清除重试状态")
		}
	}
	record, err := s.ledger.Thread(t.Context(), cmd.ThreadID)
	if err != nil || record.Status != "ready" {
		t.Fatal(record, err)
	}
	if h.pendingCalls != 4 {
		t.Fatal("恢复后没有重新读取原Worker", h.pendingCalls)
	}
}

func TestThreadHistoryFailurePreservesUnacknowledgedWorkerFacts(t *testing.T) {
	s, h, cmd := historyFailureService(t)
	h.append(cmd.ThreadID, "reply", "")
	originals, err := s.pending(t.Context(), cmd.ThreadID, 1)
	if err != nil || len(originals) != 2 {
		t.Fatal(originals, err)
	}
	// 曾发出的序号可能领先于中心，Worker 账本丢失后以中心期望序号校准恢复报告。
	if err := s.ledger.noteThreadSeq(t.Context(), cmd.ThreadID, 12); err != nil {
		t.Fatal(err)
	}
	h.failure = session.ErrHistoryMissing
	reports, err := s.pending(t.Context(), cmd.ThreadID, 1)
	if err != nil || len(reports) != 3 || reports[2].WorkerSeq != 13 {
		t.Fatal(reports, err)
	}
	recovery := reports[2]
	gap := protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: cmd.ThreadID, EventID: recovery.EventID, WorkerSeq: recovery.WorkerSeq, Code: "worker_sequence_gap", ExpectedWorkerSeq: 1}
	if err := s.reportResult(t.Context(), gap); err != nil {
		t.Fatal(err)
	}
	reports, err = s.pending(t.Context(), cmd.ThreadID, 1)
	if err != nil || len(reports) != 3 || reports[0].EventID != originals[0].EventID || reports[1].EventID != originals[1].EventID || reports[2].WorkerSeq != 13 {
		t.Fatal("recovery overwrote pending Worker facts", reports, err)
	}
	for _, report := range originals {
		ack := protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: cmd.ThreadID, EventID: report.EventID, WorkerSeq: report.WorkerSeq, OK: true}
		if err := s.reportResult(t.Context(), ack); err != nil {
			t.Fatal(err)
		}
	}
	gap.ExpectedWorkerSeq = 3
	if err := s.reportResult(t.Context(), gap); err != nil {
		t.Fatal(err)
	}
	reports, err = s.pending(t.Context(), cmd.ThreadID, 1)
	if err != nil || len(reports) != 1 || reports[0].WorkerSeq != 3 || reports[0].EventID != recovery.EventID {
		t.Fatal(reports, err)
	}
	gap.WorkerSeq, gap.OK = 3, true
	if err := s.reportResult(t.Context(), gap); err != nil {
		t.Fatal(err)
	}
	reports, err = s.pending(t.Context(), cmd.ThreadID, 1)
	if err != nil || len(reports) != 0 {
		t.Fatal(reports, err)
	}
}

func TestThreadHistoryFailurePersistenceIsAtomic(t *testing.T) {
	s, h, cmd := historyFailureService(t)
	h.failure = session.ErrHistoryMissing
	if _, err := s.ledger.db.Exec(`CREATE TRIGGER reject_history_report BEFORE INSERT ON thread_node_reports BEGIN SELECT RAISE(FAIL,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pending(t.Context(), cmd.ThreadID, 1); err == nil {
		t.Fatal("ignored report persistence failure")
	}
	record, err := s.ledger.Thread(t.Context(), cmd.ThreadID)
	if err != nil || record.Status != "ready" {
		t.Fatal("isolated without durable report", record, err)
	}
	if _, err := s.ledger.db.Exec(`DROP TRIGGER reject_history_report`); err != nil {
		t.Fatal(err)
	}
	reports, err := s.pending(t.Context(), cmd.ThreadID, 1)
	if err != nil || len(reports) != 1 || reports[0].Kind != "thread.stopped" || !reports[0].HistoryUnavailable {
		t.Fatal(reports, err)
	}
}

package node

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestThreadMappingSurvivesHostPersistenceFailure(t *testing.T) {
	s, h, cmd := threadTestService(t)
	ctx := t.Context()
	id := threadUUID(t)
	h.fail = errors.New("Worker 账本暂时不可写")
	if _, err := s.command(ctx, id, cmd); err == nil {
		t.Fatal("Worker 未持久化仍收到确认")
	}
	record, err := s.ledger.Thread(ctx, cmd.ThreadID)
	if err != nil || record.Status != "opening" {
		t.Fatal(record, err)
	}
	if reports, err := s.ledger.nodeThreadPending(ctx, cmd.ThreadID, 1); err != nil || len(reports) != 0 {
		t.Fatal("临时 IPC 错误被终结为 open_failed", reports, err)
	}
	h.fail = nil
	dir := s.ledger.dir
	generation := s.ledger.Generation()
	if err := s.ledger.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	s.ledger = reopened
	h.ledger = reopened
	if result, err := s.command(ctx, id, cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	if reopened.Generation() != generation || h.count("open") != 1 {
		t.Fatal("重试改变了映射或重复启动")
	}
}

func TestThreadReceiptFailureAfterHostCommitDoesNotRepeatAction(t *testing.T) {
	s, h, cmd := threadTestService(t)
	ctx := t.Context()
	openID := threadUUID(t)
	if _, err := s.ledger.db.Exec(`CREATE TRIGGER thread_test_receipt_failure BEFORE INSERT ON thread_command_receipts BEGIN SELECT RAISE(FAIL,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.command(ctx, openID, cmd); err == nil {
		t.Fatal("回执账本失败未暴露")
	}
	if h.count("open") != 1 {
		t.Fatal("未到达 Worker 持久化边界")
	}
	if _, err := s.ledger.db.Exec(`DROP TRIGGER thread_test_receipt_failure`); err != nil {
		t.Fatal(err)
	}
	if result, err := s.command(ctx, openID, cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	if h.count("open") != 1 {
		t.Fatal("回执提交失败后重复启动")
	}
	message := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: cmd.ThreadID, Action: "message", StorageGeneration: s.ledger.Generation(), ClientMessageID: threadUUID(t), Content: "继续"}
	id := threadUUID(t)
	if _, err := s.ledger.db.Exec(`CREATE TRIGGER thread_test_receipt_failure BEFORE INSERT ON thread_command_receipts BEGIN SELECT RAISE(FAIL,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.command(ctx, id, message); err == nil {
		t.Fatal("回执失败未暴露")
	}
	if _, err := s.ledger.db.Exec(`DROP TRIGGER thread_test_receipt_failure`); err != nil {
		t.Fatal(err)
	}
	if result, err := s.command(ctx, id, message); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	if h.count("message") != 1 {
		t.Fatal("同一 commandID 被 Worker 执行两次")
	}
}

func TestThreadMissingLedgerAlignsStoppedReportToCoordinatorSequence(t *testing.T) {
	s, _, cmd := threadTestService(t)
	ctx := t.Context()
	cmd.Action = "stop"
	cmd.StorageGeneration = threadUUID(t)
	if result, err := s.command(ctx, threadUUID(t), cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	pending, err := s.pending(ctx, cmd.ThreadID, 1)
	if err != nil || len(pending) != 1 {
		t.Fatal(pending, err)
	}
	original := pending[0]
	var sent []protocol.ThreadReport
	s.send = func(ctx context.Context, _ string, value any) error {
		sent = append(sent, value.(protocol.ThreadReport))
		return nil
	}
	gap := protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: cmd.ThreadID, EventID: original.EventID, WorkerSeq: original.WorkerSeq, Code: "worker_sequence_gap", ExpectedWorkerSeq: 42}
	if err := s.reportResult(ctx, gap); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || sent[0].WorkerSeq != 42 || sent[0].Kind != "thread.stopped" || sent[0].EventID != original.EventID {
		t.Fatalf("缺失历史无法报告给已有 Thread：%+v", sent)
	}
	gap.OK = true
	gap.WorkerSeq = 42
	if err := s.reportResult(ctx, gap); err != nil {
		t.Fatal(err)
	}
	pending, err = s.pending(ctx, cmd.ThreadID, 1)
	if err != nil || len(pending) != 0 {
		t.Fatal(pending, err)
	}
}

func TestThreadBudgetIncludesWorkerDataAndWAL(t *testing.T) {
	s, _, _ := threadTestService(t)
	ctx := t.Context()
	// 先统计账本和配置，再加入 Worker 待补报目录，避免依赖 SQLite 的页大小。
	var baseline int64
	if err := filepath.WalkDir(s.ledger.dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return err
			}
			baseline += info.Size()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	workerDir := filepath.Join(s.ledger.dir, "thread-worker")
	if err := os.Mkdir(workerDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workerDir, "pending.db-wal"), make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.ledger.CheckThreadBudget(ctx, baseline+4096); !errors.Is(err, ErrThreadBudget) {
		t.Fatal("待补报文件未计入水位", err)
	}
	if err := s.ledger.CheckThreadBudget(ctx, baseline+4097); err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.ledger.CheckThreadBudget(canceled, 0); !errors.Is(err, context.Canceled) {
		t.Fatal("空间扫描不响应取消", err)
	}
}

func TestThreadReportRetriesAreBounded(t *testing.T) {
	s, h, cmd := threadTestService(t)
	ctx := t.Context()
	if result, err := s.command(ctx, threadUUID(t), cmd); err != nil || !result.OK {
		t.Fatal(result, err)
	}
	h.mu.Lock()
	for i := 0; i < 40; i++ {
		h.append(cmd.ThreadID, "reply", "")
	}
	h.mu.Unlock()
	sent := 0
	s.send = func(context.Context, string, any) error { sent++; return nil }
	if err := s.flush(ctx); err != nil {
		t.Fatal(err)
	}
	if sent != 32 {
		t.Fatal("初始报告未按批次发送", sent)
	}
	for i := 0; i < 100; i++ {
		if err := s.flush(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if sent != 32 {
		t.Fatal("未确认报告在退避前重复发送", sent)
	}
	// 让重试到期，并恢复发送额度；无需在测试中等待真实退避。
	for event := range s.sent {
		s.sent[event] = time.Now().Add(-2 * time.Second)
	}
	s.refill = time.Now().Add(-time.Second)
	if err := s.flush(ctx); err != nil {
		t.Fatal(err)
	}
	if sent != 64 {
		t.Fatal("到期后未重发", sent)
	}
}

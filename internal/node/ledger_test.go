package node

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/task"
)

func TestPrepareIsIdempotentAndRejectsBusySession(t *testing.T) {
	led := openTestLedger(t)
	dir := t.TempDir()
	in := samplePrepare(t)
	in.WorkingDirectory = dir
	first := led.Prepare(in, nil)
	if !first.OK || first.Silent || first.ExecutionID != in.ExecutionID || first.SessionID == "" || first.StorageGeneration != led.Generation() {
		t.Fatalf("第一次准备不正确: %+v", first)
	}
	again := in
	again.ExecutionID = mustID(t)
	again.QueueExpiresAt = time.Now().Add(-time.Minute)
	again.StorageGeneration = "not-this-generation"
	again.WorkingDirectory = filepath.Join(dir, "missing")
	second := led.Prepare(again, nil)
	if !second.OK || second.ExecutionID != first.ExecutionID || second.SessionID != first.SessionID || second.StorageGeneration != first.StorageGeneration {
		t.Fatalf("重复 prepare 没有返回原映射: %+v", second)
	}
	if receipts(t, led) != 1 {
		t.Fatal("重复 prepare 创建了第二份执行")
	}

	busyIn := samplePrepare(t)
	busyIn.TargetSessionID = first.SessionID
	busy := led.Prepare(busyIn, nil)
	if busy.OK || busy.Silent || busy.Code != task.CodeSessionBusy {
		t.Fatalf("忙碌 Session 的结果不正确: %+v", busy)
	}
	mismatch := samplePrepare(t)
	mismatch.TargetSessionID = first.SessionID
	mismatch.AgentType = "codex"
	mismatch.Capabilities = []string{"codex"}
	got := led.Prepare(mismatch, nil)
	if got.OK || got.Code != task.CodeUnsupported {
		t.Fatalf("Agent 不匹配的结果不正确: %+v", got)
	}
	if receipts(t, led) != 1 {
		t.Fatal("被拒绝的准备创建了执行")
	}
}

func TestPrepareRejectsBeforeWriting(t *testing.T) {
	led := openTestLedger(t)
	expired := samplePrepare(t)
	expired.QueueExpiresAt = time.Now().Add(-time.Second)
	if got := led.Prepare(expired, nil); got.OK || got.Silent || got.Code != task.CodeQueueTimeout {
		t.Fatalf("过期准备的结果不正确: %+v", got)
	}
	wrongGen := samplePrepare(t)
	wrongGen.StorageGeneration = mustID(t)
	if got := led.Prepare(wrongGen, nil); got.OK || got.Code != task.CodeInvalidTarget || got.Message != "存储代次不匹配" {
		t.Fatalf("代次不匹配的结果不正确: %+v", got)
	}
	unsupported := samplePrepare(t)
	unsupported.Capabilities = []string{"start"}
	if got := led.Prepare(unsupported, nil); got.OK || got.Code != task.CodeUnsupported {
		t.Fatalf("能力不匹配的结果不正确: %+v", got)
	}
	missingDir := samplePrepare(t)
	missingDir.WorkingDirectory = filepath.Join(t.TempDir(), "missing")
	if got := led.Prepare(missingDir, nil); got.OK || got.Silent || got.Code != task.CodeInvalidTarget {
		t.Fatalf("缺失目录的结果不正确: %+v", got)
	}
	relative := samplePrepare(t)
	relative.WorkingDirectory = "relative/work"
	if got := led.Prepare(relative, nil); got.OK || got.Code != task.CodeInvalidTarget {
		t.Fatalf("相对目录的结果不正确: %+v", got)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Fatal(err)
	}
	linked := samplePrepare(t)
	linked.WorkingDirectory = link
	if got := led.Prepare(linked, nil); got.OK || got.Code != task.CodeInvalidTarget {
		t.Fatalf("符号链接目录的结果不正确: %+v", got)
	}
	unknown := samplePrepare(t)
	unknown.TargetSessionID = mustID(t)
	if got := led.Prepare(unknown, nil); got.OK || got.Code != task.CodeInvalidTarget || got.Message != "节点上没有这个 Session" {
		t.Fatalf("本地缺失 Session 的结果不正确: %+v", got)
	}
	if receipts(t, led) != 0 {
		t.Fatal("拒绝的准备写入了映射")
	}
}

func TestPrepareStopsWhenPersistFails(t *testing.T) {
	t.Setenv("BATON_TEST_FAIL_PERSIST", "1")
	led := openTestLedger(t)
	called := false
	got := led.Prepare(samplePrepare(t), func(string) error {
		called = true
		return nil
	})
	if !got.Silent || called || receipts(t, led) != 0 {
		t.Fatalf("持久化失败仍继续了: %+v called %v", got, called)
	}
}

func TestPrepareDuplicateAfterBindFailureReturnsStoredMapping(t *testing.T) {
	led := openTestLedger(t)
	in := samplePrepare(t)
	if got := led.Prepare(in, func(string) error { return errors.New("绑定失败") }); !got.Silent || receipts(t, led) != 1 {
		t.Fatalf("绑定失败没有留下原映射: %+v", got)
	}
	got := led.Prepare(in, nil)
	if !got.OK || got.ExecutionID != in.ExecutionID || got.SessionID == "" {
		t.Fatalf("重试没有返回已保存的映射: %+v", got)
	}
}

func TestConcurrentPrepareSerializesOneSession(t *testing.T) {
	led := openTestLedger(t)
	sessionID := mustID(t)
	if _, err := led.db.Exec(`
		INSERT INTO sessions (session_id, agent_type, bound_execution_id, created_at)
		VALUES (?, 'pi', NULL, ?)`, sessionID, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	inputs := []PrepareInput{samplePrepare(t), samplePrepare(t)}
	for i := range inputs {
		inputs[i].TargetSessionID = sessionID
	}
	var wg sync.WaitGroup
	results := make([]PrepareReport, 2)
	wg.Add(2)
	for i := range inputs {
		go func(i int) {
			defer wg.Done()
			results[i] = led.Prepare(inputs[i], nil)
		}(i)
	}
	wg.Wait()
	ok, busy := 0, 0
	for _, got := range results {
		if got.OK && !got.Silent {
			ok++
		}
		if !got.OK && !got.Silent && got.Code == task.CodeSessionBusy {
			busy++
		}
	}
	if ok != 1 || busy != 1 || receipts(t, led) != 1 {
		t.Fatalf("并发准备没有互斥: %+v receipts %d", results, receipts(t, led))
	}
}

func TestLedgerUsesWALAndFullSync(t *testing.T) {
	led := openTestLedger(t)
	var mode string
	var syncMode int64
	if err := led.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode=%s err=%v", mode, err)
	}
	if err := led.db.QueryRow(`PRAGMA synchronous`).Scan(&syncMode); err != nil || syncMode != 2 {
		t.Fatalf("synchronous=%d err=%v", syncMode, err)
	}
	info, err := os.Stat(filepath.Join(led.dir, "node.db"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("账本权限是 %o", info.Mode().Perm())
	}
}

func openTestLedger(t *testing.T) *Ledger {
	t.Helper()
	dir := t.TempDir()
	led, err := OpenLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { led.Close() })
	return led
}

func samplePrepare(t *testing.T) PrepareInput {
	t.Helper()
	return PrepareInput{
		MessageID:      mustID(t),
		TaskID:         mustID(t),
		ExecutionID:    mustID(t),
		TaskVersion:    1,
		QueueExpiresAt: time.Now().Add(time.Minute),
		AgentType:      "pi",
		Capabilities:   []string{"pi", "start"},
	}
}

func mustID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func receipts(t *testing.T, led *Ledger) int {
	t.Helper()
	var n int
	if err := led.db.QueryRow(`SELECT COUNT(*) FROM receipts`).Scan(&n); err != nil && !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	return n
}

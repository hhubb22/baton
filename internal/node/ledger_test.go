package node

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
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

func TestPrepareChecksArtifactsBeforeBindingButKeepsExistingReceipt(t *testing.T) {
	led := openTestLedger(t)
	root := t.TempDir()
	if err := AddBrowseRoot(led.dir, "build", root); err != nil {
		t.Fatal(err)
	}
	in := samplePrepare(t)
	in.NodeID = mustID(t)
	in.RequiredArtifacts = []task.ArtifactRef{{NodeID: in.NodeID, RootID: "build", Path: "firmware.bin"}}
	binds := 0
	bind := func(string) error { binds++; return nil }
	if got := led.Prepare(in, bind); got.OK || got.Code != task.CodeArtifactUnavailable || binds != 0 || receipts(t, led) != 0 {
		t.Fatalf("缺失产物仍绑定 Worker: %+v binds=%d", got, binds)
	}
	file := filepath.Join(root, "firmware.bin")
	if err := os.WriteFile(file, []byte("FIRMWARE"), 0o600); err != nil {
		t.Fatal(err)
	}
	first := led.Prepare(in, bind)
	if !first.OK || binds != 1 {
		t.Fatalf("可用产物没有绑定: %+v", first)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	again := led.Prepare(in, bind)
	if !again.OK || again.SessionID != first.SessionID || receipts(t, led) != 1 {
		t.Fatalf("文件变化使重发丢失原执行映射: %+v", again)
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

func TestPrepareNamesUnreadableHistory(t *testing.T) {
	led := openTestLedger(t)
	in := samplePrepare(t)
	got := led.Prepare(in, func(string) error { return errHistoryUnreadable })
	if got.OK || got.Silent || got.Code != task.CodeUnavailable || got.Message == "" {
		t.Fatalf("损坏历史被静默掉了: %+v", got)
	}
	again := led.Prepare(in, func(string) error { return errors.New("绑定失败") })
	if !again.Silent {
		t.Fatalf("普通绑定失败不应该变成拒绝: %+v", again)
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
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("账本权限是 %o", info.Mode().Perm())
	}
}

func TestLedgerPathRoundTrip(t *testing.T) {
	for _, name := range []string{"absolute", "relative"} {
		t.Run(name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			dir := "节点 data %23 # &+"
			if name == "absolute" {
				var err error
				dir, err = filepath.Abs(dir)
				if err != nil {
					t.Fatal(err)
				}
			}
			led, err := OpenLedger(dir)
			if err != nil {
				t.Fatal(err)
			}
			generation := led.Generation()
			in := samplePrepare(t)
			in.WorkingDirectory = t.TempDir()
			prepared := led.Prepare(in, nil)
			if !prepared.OK {
				led.Close()
				t.Fatalf("准备失败: %+v", prepared)
			}
			if err := led.Close(); err != nil {
				t.Fatal(err)
			}
			led, err = OpenLedger(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer led.Close()
			if led.Generation() != generation || receipts(t, led) != 1 {
				t.Fatal("重开账本丢失存储代次或准备映射")
			}
			if got := led.Prepare(in, nil); got != prepared {
				t.Fatalf("重开后重复准备改变映射: %+v want %+v", got, prepared)
			}
			if _, err := os.Stat(filepath.Join(dir, "node.db")); err != nil {
				t.Fatalf("账本没有保存在指定路径: %v", err)
			}
		})
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

func TestResumedSessionReleaseCannotClearNewBinding(t *testing.T) {
	led := openTestLedger(t)
	first := samplePrepare(t)
	original := led.Prepare(first, nil)
	if !original.OK {
		t.Fatal(original)
	}
	if err := led.releaseSession(original.SessionID, first.ExecutionID); err != nil {
		t.Fatal(err)
	}
	second := samplePrepare(t)
	second.TargetSessionID = original.SessionID
	if next := led.Prepare(second, nil); !next.OK {
		t.Fatal(next)
	}
	if err := led.releaseSession(original.SessionID, first.ExecutionID); err != nil {
		t.Fatal(err)
	}
	var bound string
	if err := led.db.QueryRow(`SELECT bound_execution_id FROM sessions WHERE session_id=?`, original.SessionID).Scan(&bound); err != nil || bound != second.ExecutionID {
		t.Fatal("迟到的恢复请求清除了新执行绑定")
	}
}

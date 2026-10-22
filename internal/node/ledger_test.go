package node

import (
	"baton/internal/identity"
	"baton/internal/protocol"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

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

func TestLedgerReopenPreservesThreadReceiptsAndWorkerDiscovery(t *testing.T) {
	led := openTestLedger(t)
	ctx := t.Context()
	cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: mustID(t), Action: "open", AgentType: "pi", WorkingDirectory: t.TempDir()}
	commandID := mustID(t)
	if err := led.insertThread(ctx, commandID, cmd); err != nil {
		t.Fatal(err)
	}
	if err := led.threadStatus(ctx, cmd.ThreadID, "ready"); err != nil {
		t.Fatal(err)
	}
	if err := led.saveThreadReceipt(ctx, commandID, cmd, protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: cmd.ThreadID, OK: true}); err != nil {
		t.Fatal(err)
	}
	if err := led.RememberWorker(cmd.ThreadID, os.Getpid()); err != nil {
		t.Fatal(err)
	}
	generation := led.Generation()
	dir := led.dir
	if err := led.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Generation() != generation {
		t.Fatal("重开改变了存储代次")
	}
	record, err := reopened.Thread(ctx, cmd.ThreadID)
	if err != nil || record.Status != "ready" {
		t.Fatal(record, err)
	}
	if _, ok, err := reopened.threadReceipt(ctx, record.OpenMessageID, cmd); err != nil || !ok {
		t.Fatal("重开丢失了 Thread 命令回执", err)
	}
	var workers int
	if err := reopened.db.QueryRow(`SELECT count(*) FROM workers`).Scan(&workers); err != nil || workers != 1 {
		t.Fatal("Worker 索引未保留", workers, err)
	}
	// Worker 索引丢失时，Thread 映射仍用于发现并重连原 Worker。
	if _, err := reopened.db.Exec(`DELETE FROM workers`); err != nil {
		t.Fatal(err)
	}
	ids, err := reopened.WorkerSessions()
	if err != nil || !reflect.DeepEqual(ids, []string{record.SessionID}) {
		t.Fatal(ids, err)
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
			cmd := protocol.ThreadCommand{ThreadID: mustID(t), AgentType: "pi", WorkingDirectory: t.TempDir()}
			if err := led.insertThread(t.Context(), mustID(t), cmd); err != nil {
				led.Close()
				t.Fatal(err)
			}
			original, err := led.Thread(t.Context(), cmd.ThreadID)
			if err != nil {
				led.Close()
				t.Fatal(err)
			}
			if err := led.Close(); err != nil {
				t.Fatal(err)
			}
			led, err = OpenLedger(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer led.Close()
			got, err := led.Thread(t.Context(), cmd.ThreadID)
			if err != nil || got != original || led.Generation() != generation {
				t.Fatal("重开后 Thread 映射或存储代次改变", got, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "node.db")); err != nil {
				t.Fatal(err)
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

func mustID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

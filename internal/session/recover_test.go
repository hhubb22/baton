package session

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func ledgerOptions(t *testing.T) ThreadOptions {
	t.Helper()
	return ThreadOptions{ThreadID: mustSessionID(t), StorageGeneration: "generation", AgentType: "pi", WorkingDirectory: t.TempDir()}
}
func createTestThreadDB(t *testing.T, data string, options ThreadOptions) *sql.DB {
	t.Helper()
	db, _, err := openThreadDB(data, options, true)
	if err != nil {
		t.Fatal(err)
	}
	return db
}
func TestCorruptLedgerIsNotReplaced(t *testing.T) {
	data := t.TempDir()
	options := ledgerOptions(t)
	path, err := ThreadLedgerPath(data, options.ThreadID)
	threadMust(t, err)
	threadMust(t, os.MkdirAll(filepath.Dir(path), 0700))
	threadMust(t, os.WriteFile(path, []byte("not-a-sqlite-ledger"), 0600))
	_, err = EnsureToken(data, options.ThreadID)
	threadMust(t, err)
	err = RunWorker(context.Background(), data, options.ThreadID)
	if !errors.Is(err, ErrHistoryIncompatible) {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	threadMust(t, err)
	if string(raw) != "not-a-sqlite-ledger" {
		t.Fatal("corrupt ledger replaced")
	}
}
func TestMissingLedgerIsNotCreated(t *testing.T) {
	data := t.TempDir()
	id := mustSessionID(t)
	_, err := EnsureToken(data, id)
	threadMust(t, err)
	path, err := ThreadLedgerPath(data, id)
	threadMust(t, err)
	if err := RunWorker(context.Background(), data, id); !errors.Is(err, ErrHistoryMissing) {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing ledger created", err)
	}
}
func TestBusyLedgerIsNotTreatedAsCorrupt(t *testing.T) {
	data := t.TempDir()
	o := ledgerOptions(t)
	holder := createTestThreadDB(t, data, o)
	defer holder.Close()
	path, err := ThreadLedgerPath(data, o.ThreadID)
	threadMust(t, err)
	_, err = holder.Exec("PRAGMA journal_mode=DELETE")
	threadMust(t, err)
	_, err = holder.Exec("BEGIN EXCLUSIVE")
	threadMust(t, err)
	defer holder.Exec("ROLLBACK")
	reader, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(100)")
	threadMust(t, err)
	defer reader.Close()
	_, err = reader.Exec("SELECT COUNT(*) FROM thread_outbox")
	if err == nil {
		t.Fatal("exclusive lock did not block read")
	}
	if !errors.Is(classifyLedgerErr(err), ErrHistoryUnread) || errors.Is(classifyLedgerErr(err), ErrHistoryIncompatible) {
		t.Fatal(err)
	}
}
func TestLedgerPermissionErrorsAreUnread(t *testing.T) {
	for _, parent := range []bool{false, true} {
		t.Run(map[bool]string{false: "file", true: "directory"}[parent], func(t *testing.T) {
			data := t.TempDir()
			o := ledgerOptions(t)
			db := createTestThreadDB(t, data, o)
			threadMust(t, db.Close())
			path, err := ThreadLedgerPath(data, o.ThreadID)
			threadMust(t, err)
			denied := path
			mode := os.FileMode(0600)
			if parent {
				denied = filepath.Dir(path)
				mode = 0700
			}
			threadMust(t, os.Chmod(denied, 0))
			t.Cleanup(func() { _ = os.Chmod(denied, mode) })
			if f, err := os.Open(path); err == nil {
				f.Close()
				t.Skip("current user can read permissionless file")
			}
			db, _, err = openThreadDB(data, o, false)
			if db != nil {
				db.Close()
			}
			if !errors.Is(err, ErrHistoryUnread) {
				t.Fatal(err)
			}
		})
	}
}
func TestLedgerIOErrorIsUnread(t *testing.T) {
	for _, err := range []error{&os.PathError{Op: "read", Path: "thread.db", Err: syscall.EIO}, &os.PathError{Op: "open", Path: "malformed/thread.db", Err: os.ErrPermission}, errors.New("malformed file URI")} {
		got := classifyLedgerErr(err)
		if !errors.Is(got, ErrHistoryUnread) || errors.Is(got, ErrHistoryIncompatible) || !errors.Is(got, err) {
			t.Fatal(got)
		}
	}
}
func TestLedgerSQLiteOpenErrorIsUnread(t *testing.T) {
	db, err := sql.Open("sqlite", "file://invalid/thread.db")
	threadMust(t, err)
	defer db.Close()
	err = db.Ping()
	if err == nil {
		t.Fatal("invalid URI accepted")
	}
	if got := classifyLedgerErr(err); !errors.Is(got, ErrHistoryUnread) || !errors.Is(got, err) {
		t.Fatal(got)
	}
}
func TestChmodDBRequiresLedgerButNotSidecars(t *testing.T) {
	path := filepath.Join(t.TempDir(), "thread.db")
	if err := chmodDB(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	threadMust(t, os.WriteFile(path, nil, 0600))
	threadMust(t, chmodDB(path))
}
func TestLedgerPathRoundTrip(t *testing.T) {
	for _, absolute := range []bool{false, true} {
		t.Run(map[bool]string{false: "relative", true: "absolute"}[absolute], func(t *testing.T) {
			t.Chdir(t.TempDir())
			data := "Session data 中文 %23 # &+"
			if absolute {
				var err error
				data, err = filepath.Abs(data)
				threadMust(t, err)
			}
			o := ledgerOptions(t)
			db := createTestThreadDB(t, data, o)
			_, err := db.Exec("UPDATE thread_meta SET native_session_id='preserved'")
			threadMust(t, err)
			threadMust(t, db.Close())
			db, _, err = openThreadDB(data, o, false)
			threadMust(t, err)
			defer db.Close()
			var native string
			threadMust(t, db.QueryRow("SELECT native_session_id FROM thread_meta").Scan(&native))
			if native != "preserved" {
				t.Fatal(native)
			}
			path, err := ThreadLedgerPath(data, o.ThreadID)
			threadMust(t, err)
			if !strings.Contains(path, data) {
				t.Fatal(path)
			}
		})
	}
}
func waitWorkerDown(t *testing.T, endpoint, token string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		c, err := Dial(ctx, endpoint, token)
		cancel()
		if err != nil {
			return
		}
		c.Close()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("Worker did not stop")
}
func runWorkerWhenFree(ctx context.Context, dir, id string) error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := RunWorker(ctx, dir, id)
		if ctx.Err() != nil {
			return nil
		}
		if !errors.Is(err, ErrSessionOwned) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
}

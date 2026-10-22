package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestHostThreadHistoryFailureClassification(t *testing.T) {
	for _, kind := range []string{"missing", "empty", "corrupt", "wrong_schema"} {
		t.Run(kind, func(t *testing.T) {
			data := t.TempDir()
			options := ledgerOptions(t)
			path, err := ThreadLedgerPath(data, options.ThreadID)
			threadMust(t, err)
			_, err = EnsureToken(data, options.ThreadID)
			threadMust(t, err)
			want := ErrHistoryIncompatible
			switch kind {
			case "missing":
				want = ErrHistoryMissing
			case "empty":
				threadMust(t, os.WriteFile(path, nil, 0600))
			case "corrupt":
				threadMust(t, os.WriteFile(path, []byte("not sqlite"), 0600))
			case "wrong_schema":
				db := createTestThreadDB(t, data, options)
				_, err = db.Exec("DROP TABLE thread_meta")
				threadMust(t, err)
				threadMust(t, db.Close())
			}
			h := &Host{DataDir: data}
			if err := h.Reconcile(context.Background(), options.ThreadID); !errors.Is(err, want) {
				t.Fatal(kind, err)
			}
			if _, err := h.ThreadPending(context.Background(), options.ThreadID, 0); !errors.Is(err, want) {
				t.Fatal(kind, err)
			}
			if kind == "missing" {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("missing ledger created", err)
				}
			}
			if kind == "empty" {
				info, err := os.Stat(path)
				threadMust(t, err)
				if info.Size() != 0 {
					t.Fatal("empty ledger replaced")
				}
			}
			if kind == "corrupt" {
				raw, err := os.ReadFile(path)
				threadMust(t, err)
				if string(raw) != "not sqlite" {
					t.Fatal("corrupt ledger replaced")
				}
			}
			entries, err := os.ReadDir(filepath.Dir(path))
			threadMust(t, err)
			for _, entry := range entries {
				if entry.Name() == "worker.log" {
					t.Fatal("invalid ledger started Worker")
				}
			}
		})
	}
}

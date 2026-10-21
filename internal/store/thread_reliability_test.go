package store_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"baton/internal/protocol"
	"baton/internal/store"
)

func TestThreadAuthenticationRejectsStaleSourcesAndExpiredLockWait(t *testing.T) {
	for _, kind := range []string{"report", "command_result"} {
		t.Run(kind, func(t *testing.T) {
			h := newThreadHarness(t)
			v := h.create("auth")
			r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 1, Kind: "thread.opened", StorageGeneration: "generation", NativeSessionID: "native"}
			var commandID string
			if err := h.pool.QueryRow(h.ctx, `SELECT message_id::text FROM thread_outbox WHERE thread_id=$1 ORDER BY id LIMIT 1`, v.ID).Scan(&commandID); err != nil {
				t.Fatal(err)
			}
			save := func(ctx context.Context, src protocol.Source) error {
				if kind == "report" {
					_, err := h.repo.SaveThreadReport(ctx, src, r)
					return err
				}
				return h.repo.SaveThreadCommandResult(ctx, src, commandID, protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: v.ID, OK: true})
			}
			for _, change := range []func(*protocol.Source){func(s *protocol.Source) { s.ConnID = "old" }, func(s *protocol.Source) { s.EmployeeID = mustUUID(t) }, func(s *protocol.Source) { s.NodeID = mustUUID(t) }, func(s *protocol.Source) { s.CredentialID = mustUUID(t) }} {
				src := h.src
				change(&src)
				if err := save(h.ctx, src); !errors.Is(err, store.ErrSyncRejected) {
					t.Fatalf("forged source accepted: %v", err)
				}
			}
			if _, err := h.pool.Exec(h.ctx, `UPDATE node_credentials SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE id=$1`, h.src.CredentialID); err != nil {
				t.Fatal(err)
			}
			barrier, err := h.pool.Begin(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer barrier.Rollback(h.ctx)
			query := `SELECT id FROM threads WHERE id=$1 FOR UPDATE`
			args := []any{v.ID}
			if kind == "command_result" {
				query = `SELECT id FROM thread_outbox WHERE message_id=$1 FOR UPDATE`
				args = []any{commandID}
			}
			if _, err = barrier.Exec(h.ctx, query, args...); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(h.ctx, 3*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- save(ctx, h.src) }()
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				var waiting bool
				if err = h.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))`, barrier.Conn().PgConn().PID()).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("did not wait on business row: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			for {
				var expired bool
				if err = h.pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM node_credentials WHERE id=$1`, h.src.CredentialID).Scan(&expired); err != nil {
					t.Fatal(err)
				}
				if expired {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			if err = barrier.Rollback(h.ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-done; !errors.Is(err, store.ErrSyncRejected) {
				t.Fatalf("expired credential wrote facts: %v", err)
			}
			if n := h.count(`SELECT count(*) FROM thread_reports`); n != 0 {
				t.Fatal(n)
			}
			if n := h.count(`SELECT count(*) FROM thread_outbox WHERE acked_at IS NOT NULL`); n != 0 {
				t.Fatal(n)
			}
		})
	}
}

func TestThreadBatchGlobalLimitAndDurableRetry(t *testing.T) {
	h := newThreadHarness(t)
	for i := range 9 {
		src := h.src
		if i > 0 {
			src = h.addNode(fmt.Sprintf("node-%d", i))
		}
		for j := range 5 {
			if _, _, err := h.repo.CreateThread(h.ctx, h.owner, h.input(fmt.Sprintf("%d-%d", i, j), src.NodeID)); err != nil {
				t.Fatal(err)
			}
		}
	}
	batch, err := h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 32 {
		t.Fatalf("batch: %d %v", len(batch), err)
	}
	counts := map[string]int{}
	for _, in := range batch {
		counts[in.NodeID]++
	}
	for _, n := range counts {
		if n > 4 {
			t.Fatal("node quota exceeded", n)
		}
	}
	if n := h.count(`SELECT count(*) FROM thread_outbox WHERE attempts=1 AND next_attempt_at>clock_timestamp()`); n != 32 {
		t.Fatal("retry progress", n)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE thread_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE message_id=$1`, batch[0].MessageID); err != nil {
		t.Fatal(err)
	}
	restarted := store.New(h.pool)
	retry, err := restarted.ClaimThreadCommands(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, in := range retry {
		if in.MessageID == batch[0].MessageID {
			found = true
		}
	}
	if !found {
		t.Fatal("restart lost stable command identity")
	}
}

func TestThreadDirectoryTargetPlatformBoundaries(t *testing.T) {
	for _, tc := range []struct {
		system, directory, root string
		allowed                 bool
	}{
		{"linux", "/src/repo", "/src", true}, {"linux", "/src-other", "/src", false}, {"linux", "/src/../../private", "/src", false}, {"linux", "src/repo", "/src", false}, {"linux", "/SRC/repo", "/src", false},
		{"windows", `C:\Src\repo`, `c:\src`, true}, {"windows", `C:\src-other`, `c:\src`, false}, {"windows", `C:\src\..\private`, `c:\src`, false}, {"windows", `C:\`, `C:\`, true}, {"windows", `D:\src`, `C:\src`, false},
	} {
		if got := store.ThreadDirectoryAllowed(tc.system, tc.directory, []protocol.RuntimeRoot{{RootID: "root", Path: tc.root}}); got != tc.allowed {
			t.Fatalf("%+v got %v", tc, got)
		}
	}
}

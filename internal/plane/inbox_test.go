package plane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func (f *fixture) makeDue() {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), `UPDATE plane_deliveries SET next_attempt_at=now()-interval '1 second' WHERE processed_at IS NULL`); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) retry() {
	f.t.Helper()
	f.makeDue()
	if err := f.svc.retryPending(context.Background()); err != nil {
		f.t.Fatal(err)
	}
}

func TestInboxStoresOnlyDecisionFields(t *testing.T) {
	f := newFixture(t)
	f.apiCode = http.StatusServiceUnavailable
	e := f.event("updated", "state")
	raw, _ := json.Marshal(e)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	body["session"] = "unrelated-session-must-not-persist"
	body["data"].(map[string]any)["description_html"] = "unrelated-description-must-not-persist"
	raw, _ = json.Marshal(body)
	w := httptest.NewRecorder()
	f.svc.ServeHTTP(w, signedRequest(f.cfg, raw, uuid.NewString(), "issue"))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", w.Code)
	}
	var saved []byte
	var pending bool
	var attempts int
	if err := f.pool.QueryRow(context.Background(), `SELECT event_input,processed_at IS NULL,attempts FROM plane_deliveries`).Scan(&saved, &pending, &attempts); err != nil {
		t.Fatal(err)
	}
	var input savedEvent
	if err := json.Unmarshal(saved, &input); err != nil {
		t.Fatal(err)
	}
	if !pending || attempts != 1 || input.IssueID != e.Data.ID || input.ActorID != e.Activity.Actor.ID || input.ActorEmail != e.Activity.Actor.Email || input.StateID != e.Data.State.ID || !input.UpdatedAt.Equal(e.Data.UpdatedAt) || input.Event != e.Event || input.Action != e.Action || input.Field != e.Activity.Field || strings.Contains(string(saved), "must-not-persist") {
		t.Fatalf("incomplete or excessive inbox input: %s", saved)
	}
}

func TestInboxWriteFailureRollsBackAndLogsDelivery(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.pool.Exec(ctx, `CREATE FUNCTION fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'inbox unavailable'; END $$;
		CREATE TRIGGER fail_inbox BEFORE INSERT ON plane_deliveries FOR EACH ROW EXECUTE FUNCTION fail_inbox()`); err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	f.svc.logger = slog.New(slog.NewTextHandler(&log, nil))
	delivery := uuid.NewString()
	if status, _ := f.send(f.event("updated", "state"), delivery); status != http.StatusServiceUnavailable {
		t.Fatalf("status %d", status)
	}
	var count int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM plane_issues)+(SELECT count(*) FROM plane_deliveries)`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || !strings.Contains(log.String(), "plane_inbox_write_failed") || !strings.Contains(log.String(), delivery) || strings.Contains(log.String(), f.cfg.Secret) || strings.Contains(log.String(), f.cfg.Actors[0].Email) {
		t.Fatalf("non-atomic inbox or missing/sensitive log: count=%d log=%s", count, log.String())
	}
	if f.reads != 0 {
		t.Fatal("Plane was read before the inbox committed")
	}
}

func TestBackgroundRecoversTemporaryFailure(t *testing.T) {
	for _, fault := range []string{"api", "database", "accept_commit", "lost_response"} {
		t.Run(fault, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			switch fault {
			case "api":
				f.apiCode = http.StatusServiceUnavailable
			case "database":
				if _, err := f.pool.Exec(ctx, `CREATE FUNCTION fail_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'temporary database failure'; END $$;
					CREATE TRIGGER fail_trigger BEFORE INSERT ON plane_triggers FOR EACH ROW EXECUTE FUNCTION fail_trigger()`); err != nil {
					t.Fatal(err)
				}
			case "accept_commit":
				f.repo.SetTaskCommitHook(func(context.Context) error { return errors.New("temporary commit failure") })
			case "lost_response":
				f.restart(lostAcceptance{f.repo})
			}
			delivery := uuid.NewString()
			e := f.event("updated", "state")
			if status, _ := f.send(e, delivery); status != http.StatusServiceUnavailable {
				t.Fatalf("status %d", status)
			}
			f.mu.Lock()
			reads := f.reads
			f.apiCode = 0
			f.mu.Unlock()
			f.repo.SetTaskCommitHook(nil)
			if fault == "database" {
				if _, err := f.pool.Exec(ctx, `DROP TRIGGER fail_trigger ON plane_triggers`); err != nil {
					t.Fatal(err)
				}
			}
			if fault == "lost_response" {
				f.change(func(i *issue) { i.Labels = nil })
			}
			f.restart(f.repo)
			if err := f.svc.retryPending(ctx); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			if f.reads != reads {
				t.Error("retried before the backoff elapsed")
			}
			f.mu.Unlock()
			f.retry()
			f.assertTasks(1)
			var outcome, taskID string
			if err := f.pool.QueryRow(ctx, `SELECT d.outcome,t.task_id::text FROM plane_deliveries d JOIN plane_triggers t USING(trigger_id)`).Scan(&outcome, &taskID); err != nil {
				t.Fatal(err)
			}
			if status, res := f.send(e, delivery); outcome != "accepted" || status != http.StatusOK || res.TaskID != taskID {
				t.Fatalf("background/replay: %s %d %+v", outcome, status, res)
			}
			f.assertTasks(1)
		})
	}
}

func TestBackgroundRetryExhaustion(t *testing.T) {
	f := newFixture(t)
	f.apiCode = http.StatusServiceUnavailable
	e := f.event("updated", "state")
	delivery := uuid.NewString()
	if status, _ := f.send(e, delivery); status != http.StatusServiceUnavailable {
		t.Fatalf("status %d", status)
	}
	for i := 1; i <= maxAttempts; i++ {
		f.retry()
	}
	var attempts int
	var processed bool
	var outcome, code string
	if err := f.pool.QueryRow(context.Background(), `SELECT attempts,processed_at IS NOT NULL,outcome,block_code FROM plane_deliveries`).Scan(&attempts, &processed, &outcome, &code); err != nil {
		t.Fatal(err)
	}
	if attempts != maxAttempts || !processed || outcome != "blocked" || code != "retry_exhausted" {
		t.Fatalf("attempts=%d processed=%v outcome=%s code=%s", attempts, processed, outcome, code)
	}
	f.apiCode = 0
	f.retry()
	if status, res := f.send(e, delivery); status != http.StatusOK || res.Code != "retry_exhausted" {
		t.Fatalf("exhausted replay %d %+v", status, res)
	}
	f.assertTasks(0)
	for attempt, want := range map[int]time.Duration{1: 5 * time.Second, 2: 10 * time.Second, 7: 5 * time.Minute, 8: 5 * time.Minute} {
		if got := retryDelay(attempt); got != want {
			t.Fatalf("backoff(%d)=%s want=%s", attempt, got, want)
		}
	}
}

func TestBackgroundRechecksCurrentApproval(t *testing.T) {
	f := newFixture(t)
	f.apiCode = http.StatusServiceUnavailable
	if status, _ := f.send(f.event("updated", "state"), uuid.NewString()); status != http.StatusServiceUnavailable {
		t.Fatalf("status %d", status)
	}
	f.mu.Lock()
	f.apiCode = 0
	f.mu.Unlock()
	f.change(func(i *issue) { i.Labels = nil })
	f.retry()
	var outcome, code string
	if err := f.pool.QueryRow(context.Background(), `SELECT outcome,block_code FROM plane_deliveries`).Scan(&outcome, &code); err != nil || outcome != "blocked" || code != "design_not_approved" {
		t.Fatalf("approval changed: %s %s %v", outcome, code, err)
	}
	f.assertTasks(0)
}

func TestBackgroundRecoversUnattemptedInboxAndStops(t *testing.T) {
	f := newFixture(t)
	e := f.event("updated", "state")
	raw, _ := json.Marshal(e)
	if _, conflict, err := f.svc.receive(context.Background(), uuid.NewString(), raw, e); err != nil || conflict {
		t.Fatalf("receive conflict=%v err=%v", conflict, err)
	}
	f.restart(f.repo)
	f.makeDue()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.svc.Run(ctx)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var accepted bool
		err := f.pool.QueryRow(context.Background(), `SELECT outcome='accepted' FROM plane_deliveries`).Scan(&accepted)
		if err == nil && accepted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unattempted inbox was not recovered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("background retry did not stop")
	}
	f.assertTasks(1)
}

func TestExhaustedAttemptRecoversCommittedTask(t *testing.T) {
	f := newFixture(t)
	f.restart(lostAcceptance{f.repo})
	if status, _ := f.send(f.event("updated", "state"), uuid.NewString()); status != http.StatusServiceUnavailable {
		t.Fatalf("status %d", status)
	}
	if _, err := f.pool.Exec(context.Background(), `UPDATE plane_deliveries SET attempts=$1`, maxAttempts); err != nil {
		t.Fatal(err)
	}
	f.restart(f.repo)
	f.retry()
	var outcome string
	if err := f.pool.QueryRow(context.Background(), `SELECT outcome FROM plane_deliveries`).Scan(&outcome); err != nil || outcome != "accepted" {
		t.Fatalf("committed at exhaustion: %s %v", outcome, err)
	}
	f.assertTasks(1)
}

func TestBackgroundAndRedeliveryAreIdempotent(t *testing.T) {
	f := newFixture(t)
	f.apiCode = http.StatusServiceUnavailable
	e := f.event("updated", "state")
	delivery := uuid.NewString()
	if status, _ := f.send(e, delivery); status != http.StatusServiceUnavailable {
		t.Fatalf("status %d", status)
	}
	f.mu.Lock()
	f.apiCode = 0
	f.mu.Unlock()
	f.makeDue()
	other, err := New(f.pool, f.cfg, f.repo, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				if err := other.retryPending(context.Background()); err != nil {
					t.Error(err)
				}
			} else {
				id := delivery
				if i%3 == 0 {
					id = uuid.NewString()
				}
				if status, _ := f.send(e, id); status != http.StatusOK && status != http.StatusServiceUnavailable {
					t.Errorf("replay status %d", status)
				}
			}
		}(i)
	}
	wg.Wait()
	f.assertTasks(1)
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM plane_deliveries WHERE outcome='accepted'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("inbox count=%d err=%v", count, err)
	}
}

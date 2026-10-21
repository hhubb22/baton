package store_test

import (
	"encoding/json"
	"strings"
	"testing"

	"baton/internal/protocol"
	"baton/internal/store"
)

func TestThreadOutboxLostAckPreservesCommandOrder(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("order")
	for _, mid := range []string{"second", "third"} {
		if _, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: mid, Content: mid}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "withdraw", "third"); err != nil {
		t.Fatal(err)
	}
	want := []struct{ action, mid string }{{"open", ""}, {"message", "order:first"}, {"message", "second"}, {"message", "third"}, {"withdraw", "third"}}
	for _, w := range want {
		batch, err := h.repo.ClaimThreadCommands(h.ctx)
		if err != nil || len(batch) != 1 {
			t.Fatalf("claim %d %v", len(batch), err)
		}
		var env protocol.Envelope
		var cmd protocol.ThreadCommand
		if json.Unmarshal(batch[0].Envelope, &env) != nil || json.Unmarshal(env.Body, &cmd) != nil || cmd.Action != w.action || cmd.ClientMessageID != w.mid {
			t.Fatalf("order %+v want %+v", cmd, w)
		}
		if again, err := h.repo.ClaimThreadCommands(h.ctx); err != nil || len(again) != 0 {
			t.Fatal("unacknowledged command overtaken", again, err)
		}
		if _, err = h.pool.Exec(h.ctx, `UPDATE thread_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE message_id=$1`, batch[0].MessageID); err != nil {
			t.Fatal(err)
		}
		retry, err := h.repo.ClaimThreadCommands(h.ctx)
		if err != nil || len(retry) != 1 || retry[0].MessageID != batch[0].MessageID {
			t.Fatal("lost ACK changed command identity", retry, err)
		}
		if err = h.repo.SaveThreadCommandResult(h.ctx, h.src, batch[0].MessageID, protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: v.ID, OK: true}); err != nil {
			t.Fatal(err)
		}
		if w.action == "open" {
			if waiting, err := h.repo.ClaimThreadCommands(h.ctx); err != nil || len(waiting) != 0 {
				t.Fatal("message sent before storage generation", waiting, err)
			}
			h.opened(v)
		}
	}
}

func TestThreadArchivedObsoleteCommandsDoNotBlockStop(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("archived-outbox")
	h.opened(v)
	h.start(v, 2, 1, "archived-outbox:first")
	if _, err := h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "archive", ""); err != nil {
		t.Fatal(err)
	}
	h.report(v.ID, 4, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Reason = "stopped"; r.QueueEmpty = true })
	batch, err := h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 1 {
		t.Fatal("obsolete command blocked stop", batch, err)
	}
	var env protocol.Envelope
	var cmd protocol.ThreadCommand
	if json.Unmarshal(batch[0].Envelope, &env) != nil || json.Unmarshal(env.Body, &cmd) != nil || cmd.Action != "stop" || cmd.StorageGeneration != "generation" {
		t.Fatal(cmd)
	}
}

func TestThreadOpenFailureRemainsArchivable(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("open-failure")
	h.report(v.ID, 1, "thread.open_failed", func(r *protocol.ThreadReport) { r.Reason = "directory does not exist" })
	view, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.Status != "stopped" || view.StatusReason != "directory does not exist" || len(view.PendingMessages) != 0 {
		t.Fatal(view, err)
	}
	if _, err = h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	archived, err := h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "archive", "")
	if err != nil || archived.Status != "archived" {
		t.Fatal(archived, err)
	}
	if batch, err := h.repo.ClaimThreadCommands(h.ctx); err != nil || len(batch) != 0 {
		t.Fatal("failed open dispatched messages", batch, err)
	}
}

func TestThreadMessageEncodingLimitDoesNotPoisonOutbox(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("wire-size")
	oversize := h.input("oversize", h.src.NodeID)
	oversize.Message.Content = strings.Repeat("\x01", 64<<10)
	_, _, err := h.repo.CreateThread(h.ctx, h.owner, oversize)
	threadRejection(t, err, 413)
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "oversize", Content: oversize.Message.Content})
	threadRejection(t, err, 413)
	if n := h.count(`SELECT count(*) FROM thread_outbox`); n != 2 {
		t.Fatal("oversize intent committed", n)
	}
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "bounded", Content: strings.Repeat("\x01", 32<<10)}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.repo.ClaimThreadCommands(h.ctx); err != nil {
		t.Fatal("valid outbox blocked", err)
	}
}

func TestThreadClaimFailureRollsBackEntireBatch(t *testing.T) {
	h := newThreadHarness(t)
	h.create("one")
	h.create("two")
	if _, err := h.pool.Exec(h.ctx, `CREATE FUNCTION reject_thread_retry() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.thread_id=(SELECT id FROM threads WHERE client_thread_id='two') THEN RAISE EXCEPTION 'injected_retry_failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_thread_retry BEFORE UPDATE ON thread_outbox FOR EACH ROW EXECUTE FUNCTION reject_thread_retry()`); err != nil {
		t.Fatal(err)
	}
	if batch, err := h.repo.ClaimThreadCommands(h.ctx); err == nil || len(batch) != 0 {
		t.Fatal("failed claim returned commands", batch, err)
	}
	if n := h.count(`SELECT count(*) FROM thread_outbox WHERE attempts<>0`); n != 0 {
		t.Fatal("partial retry progress committed", n)
	}
	if _, err := h.pool.Exec(h.ctx, `DROP TRIGGER reject_thread_retry ON thread_outbox`); err != nil {
		t.Fatal(err)
	}
	if batch, err := h.repo.ClaimThreadCommands(h.ctx); err != nil || len(batch) != 2 {
		t.Fatal("failed claim lost commands", batch, err)
	}
}

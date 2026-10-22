package store_test

import (
	"encoding/json"
	"strings"
	"testing"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

func TestProjectThreadModelFailureNotificationAndRead(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	projectReport(t, h, id, "thread.opened", func(r *protocol.ThreadReport) { r.StorageGeneration = "generation" })
	view, err := h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || len(view.PendingMessages) != 1 {
		t.Fatal(view, err)
	}
	first := view.PendingMessages[0]
	const reason = "model selection failed: model unavailable"
	var seq int64
	if err = h.pool.QueryRow(h.ctx, `SELECT last_worker_seq+1 FROM threads WHERE id=$1`, id).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: mustUUID(t), WorkerSeq: seq, Kind: "message.withdrawn", ClientMessageID: first.ClientMessageID, Reason: reason}
	if _, err = h.pool.Exec(h.ctx, `CREATE FUNCTION reject_thread_message_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.source_type='thread_message_failed' THEN RAISE EXCEPTION 'injected_input_failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_thread_message_failure BEFORE INSERT ON project_agent_input_queue FOR EACH ROW EXECUTE FUNCTION reject_thread_message_failure()`); err != nil {
		t.Fatal(err)
	}
	if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err == nil || ack.OK {
		t.Fatal("input failure acknowledged", ack, err)
	}
	view, err = h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || view.LastWorkerSeq != seq-1 || len(view.PendingMessages) != 1 || len(view.FailedMessages) != 0 {
		t.Fatal("partial withdrawal committed", view, err)
	}
	if _, err = h.pool.Exec(h.ctx, `DROP TRIGGER reject_thread_message_failure ON project_agent_input_queue`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err != nil || !ack.OK {
			t.Fatal(ack, err)
		}
	}
	// 新事件再次报告同一条消息，也不会重复通知或重新开启唤醒。
	projectReport(t, h, id, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = first.ClientMessageID; r.Reason = reason })
	var payload []byte
	var wake bool
	if err = h.pool.QueryRow(h.ctx, `SELECT payload,wake_required FROM project_agent_input_queue WHERE source_type='thread_message_failed'`).Scan(&payload, &wake); err != nil || !wake || !strings.Contains(string(payload), reason) || !strings.Contains(string(payload), first.ClientMessageID) {
		t.Fatal(string(payload), wake, err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='thread_message_failed'`); n != 1 {
		t.Fatal("duplicate failure input", n)
	}
	view, err = h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || view.Status != "idle" || view.CurrentTurn != nil || len(view.PendingMessages) != 0 || len(view.FailedMessages) != 1 || view.FailedMessages[0].StatusReason != reason {
		t.Fatal(view, err)
	}
	raw, bad := h.call(t, "threads.get", map[string]any{"thread_id": id})
	text, _ := readToolPage(t, raw)
	if bad || !strings.Contains(text, `"failed_messages"`) || !strings.Contains(text, `"status_reason":"`+reason+`"`) {
		t.Fatal(string(raw))
	}
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, id, store.ThreadMessageInput{ClientMessageID: "employee-failure", Content: "employee"}); err != nil {
		t.Fatal(err)
	}
	projectReport(t, h, id, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = "employee-failure"; r.Reason = reason })
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='thread_message_failed'`); n != 1 {
		t.Fatal("employee failure entered input queue", n)
	}
	req := h.req
	req.Operation, req.LastSeq = "claim_inputs", h.seq
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	claim := out.(projectagent.Claim)
	var input struct {
		Message struct {
			Content []struct{ Text string } `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(claim.Event.Payload, &input); err != nil || len(input.Message.Content) != 1 {
		t.Fatal("failure input missing", string(claim.Event.Payload), err)
	}
	var items []struct {
		SourceType string          `json:"source_type"`
		Payload    json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(input.Message.Content[0].Text), &items); err != nil || len(items) != 1 || items[0].SourceType != "thread_message_failed" || !strings.Contains(string(items[0].Payload), reason) {
		t.Fatal("failure did not reach Project Agent", string(claim.Event.Payload), err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM thread_turns`); n != 0 {
		t.Fatal("failed message created a turn", n)
	}
}

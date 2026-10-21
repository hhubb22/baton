package store_test

import (
	"testing"

	"baton/internal/projectagent"
	"baton/internal/protocol"
)

func TestThreadProjectOriginAndInputFailureAreAtomic(t *testing.T) {
	h := newThreadHarness(t)
	p, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "Origin"})
	if err != nil {
		t.Fatal(err)
	}
	in := h.input("agent-created", h.src.NodeID)
	in.ProjectID = p.ID
	in.CreatedBy = "project_agent"
	in.OriginConversationID = p.Conversation.ID
	in.OriginToolCallID = "create-tool"
	v, created, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil || !created || v.CreatedBy != "project_agent" {
		t.Fatal(v, created, err)
	}
	in.ClientThreadID = "different-id"
	_, _, err = h.repo.CreateThread(h.ctx, h.owner, in)
	threadRejection(t, err, 409)
	h.opened(v)
	h.start(v, 2, 1, "agent-created:first")
	h.report(v.ID, 4, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Content = "complete" })
	if _, err = h.pool.Exec(h.ctx, `CREATE FUNCTION reject_thread_end_input() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.source_type='turn_ended' THEN RAISE EXCEPTION 'injected_input_failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_thread_end_input BEFORE INSERT ON project_agent_input_queue FOR EACH ROW EXECUTE FUNCTION reject_thread_end_input()`); err != nil {
		t.Fatal(err)
	}
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 5, Kind: "turn.ended", WorkerTurnSeq: 1, Reason: "completed", QueueEmpty: true}
	if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err == nil || ack.OK {
		t.Fatal("failed input acknowledged", ack, err)
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.LastWorkerSeq != 4 || view.Status != "running" || view.CurrentTurn == nil {
		t.Fatal("partial end committed", view, err)
	}
	if _, err = h.pool.Exec(h.ctx, `DROP TRIGGER reject_thread_end_input ON project_agent_input_queue`); err != nil {
		t.Fatal(err)
	}
	if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err != nil || !ack.OK {
		t.Fatal(ack, err)
	}
	if n := h.count(`SELECT count(*) FROM project_agent_input_queue WHERE source_type='turn_ended'`); n != 1 {
		t.Fatal(n)
	}
}

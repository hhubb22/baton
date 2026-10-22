package store_test

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"baton/internal/protocol"
	"baton/internal/store"
)

func modelAgents() []protocol.RuntimeAgent {
	return []protocol.RuntimeAgent{
		{AgentType: "pi", Version: "1", Status: "available", DefaultModel: "model-a", Models: []protocol.RuntimeModel{{ID: "model-a", Name: "A"}, {ID: "model-b", Name: "B"}}, Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Steer: true, Stop: true, Resume: true, SwitchModel: true}},
		{AgentType: "kiro", Version: "1", Status: "available", DefaultModel: "model-a", Models: []protocol.RuntimeModel{{ID: "model-a", Name: "A"}, {ID: "model-b", Name: "B"}}, Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Stop: true}},
	}
}
func setThreadModelAgents(t *testing.T, h *threadHarness, agents []protocol.RuntimeAgent) {
	t.Helper()
	_, err := h.repo.SaveRuntimeReport(h.ctx, h.src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: agents})
	if err != nil {
		t.Fatal(err)
	}
}
func threadCommand(t *testing.T, intent store.ThreadIntent) protocol.ThreadCommand {
	t.Helper()
	var env protocol.Envelope
	var cmd protocol.ThreadCommand
	if err := json.Unmarshal(intent.Envelope, &env); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(env.Body, &cmd); err != nil {
		t.Fatal(err)
	}
	return cmd
}

func TestThreadModelDefaultsSelectionAndIdempotency(t *testing.T) {
	h := newThreadHarness(t)
	setThreadModelAgents(t, h, modelAgents())
	in := h.input("default-model", h.src.NodeID)
	v, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil || v.Model != "model-a" {
		t.Fatal(v, err)
	}
	agents := modelAgents()
	agents[0].DefaultModel = "model-b"
	setThreadModelAgents(t, h, agents)
	replayed, created, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil || created || replayed.ID != v.ID || replayed.Model != "model-a" {
		t.Fatal("default change altered retry", replayed, created, err)
	}
	in.Model = "model-b"
	_, _, err = h.repo.CreateThread(h.ctx, h.owner, in)
	threadRejection(t, err, 409)
	in.ClientThreadID = "explicit-model"
	in.Message.ClientMessageID = "explicit-first"
	explicit, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil || explicit.Model != "model-b" {
		t.Fatal(explicit, err)
	}
	for _, model := range []string{"unknown", "model-a\n", strings.Repeat("x", 513)} {
		bad := h.input("bad-"+model[:1], h.src.NodeID)
		bad.Model = model
		_, _, err = h.repo.CreateThread(h.ctx, h.owner, bad)
		threadRejection(t, err, 422)
	}
	if n := h.count(`SELECT count(*) FROM threads`); n != 2 {
		t.Fatal("invalid models persisted", n)
	}
	batch, err := h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 2 {
		t.Fatal(batch, err)
	}
	for _, intent := range batch {
		cmd := threadCommand(t, intent)
		want := "model-a"
		if intent.ThreadID == explicit.ID {
			want = "model-b"
		}
		if cmd.Action != "open" || cmd.Model != want {
			t.Fatal(cmd)
		}
	}
}

func TestThreadModelValidationAndLegacyReports(t *testing.T) {
	h := newThreadHarness(t)
	setThreadModelAgents(t, h, modelAgents())
	v := h.create("models")
	h.opened(v)
	before := h.count(`SELECT count(*) FROM thread_outbox`)
	for _, m := range []store.ThreadMessageInput{
		{ClientMessageID: "unknown", Content: "next", Model: "missing"},
		{ClientMessageID: "steer-model", Content: "next", Mode: "steer", Model: "model-a"},
		{ClientMessageID: "bad-model", Content: "next", Model: "model-a\t"},
	} {
		_, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, m)
		threadRejection(t, err, 422)
	}
	if n := h.count(`SELECT count(*) FROM thread_outbox`); n != before {
		t.Fatal("rejected messages enqueued", n)
	}
	m := store.ThreadMessageInput{ClientMessageID: "switch", Content: "next", Model: "model-b"}
	accepted, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, m)
	if err != nil || accepted.Model != "model-b" {
		t.Fatal(accepted, err)
	}
	view, _ := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if view.Model != "model-a" {
		t.Fatal("queued model became current", view.Model)
	}
	h.start(v, 2, 1, "models:first")
	h.report(v.ID, 4, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Reason = "completed"; r.QueueEmpty = false })
	h.report(v.ID, 5, "turn.started", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.ClientMessageID = "switch"; r.Model = "model-b" })
	view, err = h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.Model != "model-b" || view.CurrentTurn == nil || view.CurrentTurn.Model != "model-b" {
		t.Fatal(view, err)
	}
	h.report(v.ID, 6, "message.sent", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.ClientMessageID = "switch" })
	end := h.report(v.ID, 7, "turn.ended", func(r *protocol.ThreadReport) {
		r.WorkerTurnSeq = 2
		r.Reason = "completed"
		r.QueueEmpty = true
		r.Model = "actual-b"
	})
	ack, err := h.repo.SaveThreadReport(h.ctx, h.src, end)
	if err != nil || !ack.OK {
		t.Fatal(ack, err)
	}
	view, _ = h.repo.GetThread(h.ctx, h.owner, v.ID)
	if view.Model != "actual-b" || h.count(`SELECT count(*) FROM thread_turns WHERE model='actual-b' AND worker_turn_seq=2`) != 1 || h.count(`SELECT count(*) FROM thread_turns WHERE model='model-a' AND worker_turn_seq=1`) != 1 {
		t.Fatal("turn models not persisted", view)
	}
	agents := modelAgents()
	agents[0].Models = nil
	setThreadModelAgents(t, h, agents)
	// 已接受的请求优先返回原消息，不受新报告影响。
	if again, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, m); err != nil || again.ID != accepted.ID {
		t.Fatal(again, err)
	}
	m.Model = "model-a"
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, m)
	threadRejection(t, err, 409)
	noList := h.input("empty-model-list", h.src.NodeID)
	noList.Model = "model-a"
	_, _, err = h.repo.CreateThread(h.ctx, h.owner, noList)
	threadRejection(t, err, 422)
	noList.Model = ""
	if result, _, err := h.repo.CreateThread(h.ctx, h.owner, noList); err != nil || result.Model != "model-a" {
		t.Fatal(result, err)
	}
	kiro := h.input("fixed-model", h.src.NodeID)
	kiro.AgentType = "kiro"
	kiro.Model = "model-b"
	fixed, _, err := h.repo.CreateThread(h.ctx, h.owner, kiro)
	if err != nil || fixed.Model != "model-b" {
		t.Fatal(fixed, err)
	}
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, fixed.ID, store.ThreadMessageInput{ClientMessageID: "unsupported", Content: "next", Model: "model-a"})
	threadRejection(t, err, 422)
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, fixed.ID, store.ThreadMessageInput{ClientMessageID: "inherit", Content: "next"}); err != nil {
		t.Fatal(err)
	}
	setThreadModelAgents(t, h, nil)
	legacy := h.create("legacy-model")
	if legacy.Model != "" {
		t.Fatal(legacy)
	}
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, legacy.ID, store.ThreadMessageInput{ClientMessageID: "legacy-explicit", Content: "next", Model: "model-a"})
	threadRejection(t, err, 422)
}

func TestThreadModelOpenRetryAndMessageCommandsKeepOriginalModel(t *testing.T) {
	h := newThreadHarness(t)
	setThreadModelAgents(t, h, modelAgents())
	v := h.create("model-outbox")
	batch, err := h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 1 {
		t.Fatal(batch, err)
	}
	open := batch[0]
	if cmd := threadCommand(t, open); cmd.Model != "model-a" {
		t.Fatal(cmd)
	}
	h.report(v.ID, 1, "thread.opened", func(r *protocol.ThreadReport) { r.StorageGeneration = "generation"; r.Model = "actual-default" })
	if _, err = h.pool.Exec(h.ctx, `UPDATE thread_outbox SET next_attempt_at=clock_timestamp() WHERE message_id=$1`, open.MessageID); err != nil {
		t.Fatal(err)
	}
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 1 || string(batch[0].Envelope) != string(open.Envelope) {
		t.Fatal("open retry changed after model report", batch, err)
	}
	ack := func(intent store.ThreadIntent) {
		t.Helper()
		if err := h.repo.SaveThreadCommandResult(h.ctx, h.src, intent.MessageID, protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: v.ID, OK: true}); err != nil {
			t.Fatal(err)
		}
	}
	ack(open)
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 1 {
		t.Fatal(batch, err)
	}
	if cmd := threadCommand(t, batch[0]); cmd.Action != "message" || cmd.Model != "" {
		t.Fatal("first message must inherit initial model", cmd)
	}
	ack(batch[0])
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "outbox-switch", Content: "next", Model: "model-b"}); err != nil {
		t.Fatal(err)
	}
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil || len(batch) != 1 {
		t.Fatal(batch, err)
	}
	if cmd := threadCommand(t, batch[0]); cmd.Action != "message" || cmd.Model != "model-b" || cmd.ClientMessageID != "outbox-switch" {
		t.Fatal(cmd)
	}
}

func TestThreadModelEmptyPreservesLegacyRequestHash(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("legacy-hash")
	// 旧版本规范化后的 JSON 不包含 model。
	legacy := fmt.Sprintf(`{"Input":{"client_thread_id":"legacy-hash","node_id":%q,"agent_type":"pi","working_directory":"/src/repo","execution_timeout_seconds":7200,"message":{"client_message_id":"legacy-hash:first","content":"first","mode":"queue"}},"Actor":"employee","Conversation":"","Tool":""}`, h.src.NodeID)
	want := sha256.Sum256([]byte(legacy))
	var actual []byte
	if err := h.pool.QueryRow(h.ctx, `SELECT request_hash FROM threads WHERE id=$1`, v.ID).Scan(&actual); err != nil || string(actual) != string(want[:]) {
		t.Fatalf("legacy hash differs: %x want %x: %v", actual, want, err)
	}
}

func TestThreadModelSwitchFailureWithdrawsWithoutTurn(t *testing.T) {
	h := newThreadHarness(t)
	setThreadModelAgents(t, h, modelAgents())
	v := h.create("switch-failure")
	h.report(v.ID, 1, "thread.opened", func(r *protocol.ThreadReport) { r.StorageGeneration = "generation"; r.Model = "actual-default" })
	h.report(v.ID, 2, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = "switch-failure:first" })
	in := store.ThreadMessageInput{ClientMessageID: "fail-switch", Content: "next", Model: "model-b"}
	m, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	h.report(v.ID, 3, "message.queued", func(r *protocol.ThreadReport) { r.ClientMessageID = in.ClientMessageID })
	const reason = "无法切换模型：模型不可用"
	withdrawn := h.report(v.ID, 4, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = in.ClientMessageID; r.Reason = reason })
	if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, withdrawn); err != nil || !ack.OK {
		t.Fatal(ack, err)
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.Status != "idle" || view.StatusReason != "" || view.Model != "actual-default" || view.CurrentTurn != nil || len(view.PendingMessages) != 0 {
		t.Fatal(view, err)
	}
	if n := h.count(`SELECT count(*) FROM thread_turns`); n != 0 {
		t.Fatal("failed switch opened turn", n)
	}
	before := h.count(`SELECT count(*) FROM thread_outbox`)
	again, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, in)
	if err != nil || again.ID != m.ID || again.Status != "withdrawn" || h.count(`SELECT count(*) FROM thread_outbox`) != before {
		t.Fatal("withdrawn message retried", again, err)
	}
	if again.StatusReason != reason || len(view.FailedMessages) != 1 || view.FailedMessages[0].ID != m.ID || view.FailedMessages[0].StatusReason != reason {
		t.Fatal("message failure reason missing", again, view.FailedMessages)
	}
	page, err := h.repo.ThreadTimeline(h.ctx, h.owner, v.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range page.Events {
		if event.Kind == "message.withdrawn" && strings.Contains(string(event.Payload), reason) {
			found = true
		}
	}
	if !found {
		t.Fatal("withdrawal reason missing")
	}
}

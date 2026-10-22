package control

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"baton/internal/gateway"
	"baton/internal/protocol"
	"baton/internal/store"
)

func threadControlNode(t *testing.T, h *threadControl, name string) protocol.Source {
	t.Helper()
	src := h.addNode(name)
	if _, err := h.repo.SaveRuntimeReport(t.Context(), src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: []protocol.RuntimeAgent{
		{AgentType: "pi", Version: "1.3.0", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Steer: true, Stop: true, Resume: true, SwitchModel: true}},
	}}); err != nil {
		t.Fatal(err)
	}
	return src
}
func threadControlCreate(t *testing.T, h *threadControl, src protocol.Source, key string) store.Thread {
	t.Helper()
	v, _, err := h.repo.CreateThread(t.Context(), h.owner, store.CreateThreadInput{ClientThreadID: key, NodeID: src.NodeID, AgentType: "pi", WorkingDirectory: "/src/repo", Message: store.ThreadMessageInput{ClientMessageID: key + ":first", Content: "hello"}})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestThreadDispatchSlowNodeAndLateAck(t *testing.T) {
	h := newThreadControl(t)
	slow := threadControlNode(t, h, "slow")
	fast := threadControlNode(t, h, "fast")
	for i := range 20 {
		threadControlCreate(t, h, slow, fmt.Sprintf("slow-%d", i))
	}
	v := threadControlCreate(t, h, fast, "fast")
	var sent []protocol.Envelope
	h.server.SetSender(threadSender{send: func(ctx context.Context, nodeID string, env protocol.Envelope) error {
		var attempts int
		if err := h.pool.QueryRow(ctx, `SELECT attempts FROM thread_outbox WHERE message_id=$1`, env.MessageID).Scan(&attempts); err != nil {
			return err
		}
		if attempts != 1 {
			t.Errorf("progress not committed: %d", attempts)
		}
		if nodeID == fast.NodeID {
			sent = append(sent, env)
		}
		return gateway.ErrUnavailable
	}})
	if err := h.server.deliverThreadBatch(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Fatalf("slow node blocked fast: %d", len(sent))
	}
	first := sent[0]
	result := protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: v.ID, OK: true}
	raw, _ := json.Marshal(result)
	wrong := slow
	env := protocol.Envelope{Version: protocol.Version, MessageID: compatibilityID(t), CorrelationID: first.MessageID, Priority: protocol.PriorityControl, Route: protocol.Route{To: protocol.ToControl}, Body: raw}
	if err := h.server.Handle(t.Context(), wrong, env); err != nil {
		t.Fatal(err)
	}
	var acked bool
	if err := h.pool.QueryRow(t.Context(), `SELECT acked_at IS NOT NULL FROM thread_outbox WHERE message_id=$1`, first.MessageID).Scan(&acked); err != nil || acked {
		t.Fatal("wrong source ACK", acked, err)
	}
	for range 2 {
		if err := h.server.Handle(t.Context(), fast, env); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.pool.QueryRow(t.Context(), `SELECT acked_at IS NOT NULL FROM thread_outbox WHERE message_id=$1`, first.MessageID).Scan(&acked); err != nil || !acked {
		t.Fatal("late ACK lost", acked, err)
	}
	ack, err := h.repo.SaveThreadReport(t.Context(), fast, protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: compatibilityID(t), WorkerSeq: 1, Kind: "thread.opened", StorageGeneration: "generation", NativeSessionID: "native"})
	if err != nil || !ack.OK {
		t.Fatal(ack, err)
	}
	var actions []string
	h.server.SetSender(threadSender{send: func(_ context.Context, nodeID string, env protocol.Envelope) error {
		if nodeID == fast.NodeID {
			var cmd protocol.ThreadCommand
			_ = json.Unmarshal(env.Body, &cmd)
			actions = append(actions, cmd.Action)
		}
		return nil
	}})
	if err := h.server.deliverThreadBatch(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(actions) != 1 || actions[0] != "message" {
		t.Fatal("next message not released", actions)
	}
}

func TestThreadControlReportsOfflineAndMultiTurn(t *testing.T) {
	h := newThreadControl(t)
	src := threadControlNode(t, h, "Desk")
	if err := h.repo.MarkOffline(t.Context(), src.NodeID, src.ConnID, time.Now()); err != nil {
		t.Fatal(err)
	}
	v := threadControlCreate(t, h, src, "multi")
	var commands []protocol.ThreadCommand
	var acks []protocol.ThreadReportResult
	h.server.SetSender(threadSender{send: func(_ context.Context, _ string, env protocol.Envelope) error {
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(env.Body, &head)
		if head.Type == protocol.BodyThreadReportResult {
			var ack protocol.ThreadReportResult
			_ = json.Unmarshal(env.Body, &ack)
			acks = append(acks, ack)
		} else {
			var cmd protocol.ThreadCommand
			_ = json.Unmarshal(env.Body, &cmd)
			commands = append(commands, cmd)
		}
		return nil
	}})
	if err := h.server.deliverThreadBatch(t.Context()); err != nil || len(commands) != 0 {
		t.Fatal("offline delivery", err)
	}
	if err := h.repo.ConnectNode(t.Context(), src); err != nil {
		t.Fatal(err)
	}
	if err := h.server.deliverThreadBatch(t.Context()); err != nil || len(commands) != 0 {
		t.Fatal("unsynced delivery", err)
	}
	if err := h.repo.SyncNode(t.Context(), h.owner, src.NodeID, src.ConnID, "Desk", "linux", "pc", []string{"pi"}); err != nil {
		t.Fatal(err)
	}
	if err := h.server.deliverThreadBatch(t.Context()); err != nil || len(commands) != 1 || commands[0].Action != "open" {
		t.Fatal("online delivery", commands, err)
	}
	seq := int64(0)
	report := func(kind string, turn int64, message, content, reason string) protocol.Envelope {
		t.Helper()
		seq++
		r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: compatibilityID(t), WorkerSeq: seq, Kind: kind, WorkerTurnSeq: turn, ClientMessageID: message, Content: content, Reason: reason, QueueEmpty: true}
		if kind == "thread.opened" {
			r.StorageGeneration = "generation"
			r.NativeSessionID = "native"
		}
		raw, _ := json.Marshal(r)
		var fields map[string]any
		_ = json.Unmarshal(raw, &fields)
		fields["future_field"] = true
		raw, _ = json.Marshal(fields)
		env := protocol.Envelope{Version: protocol.Version, MessageID: compatibilityID(t), Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, Body: raw}
		if err := h.server.Handle(t.Context(), src, env); err != nil {
			t.Fatal(err)
		}
		if len(acks) == 0 || !acks[len(acks)-1].OK {
			t.Fatal("report rejected", kind, acks)
		}
		return env
	}
	report("thread.opened", 0, "", "", "")
	for turn := int64(1); turn <= 2; turn++ {
		mid := "multi:first"
		if turn == 2 {
			mid = "second"
			if _, err := h.repo.SendThreadMessage(t.Context(), h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: mid, Content: "again"}); err != nil {
				t.Fatal(err)
			}
		}
		report("turn.started", turn, mid, "", "")
		report("message.sent", turn, mid, "", "")
		for i := range 3 {
			env := report("reply", turn, "", fmt.Sprintf("reply %d", i), "")
			if err := h.server.Handle(t.Context(), src, env); err != nil {
				t.Fatal(err)
			}
		}
		report("turn.ended", turn, "", "", "completed")
	}
	view, err := h.repo.GetThread(t.Context(), h.owner, v.ID)
	if err != nil || view.Status != "idle" || view.LastWorkerSeq != seq {
		t.Fatal(view, err)
	}
	var replies int
	if err = h.pool.QueryRow(t.Context(), `SELECT count(*) FROM thread_replies WHERE thread_id=$1`, v.ID).Scan(&replies); err != nil || replies != 6 {
		t.Fatal("reply dedup", replies, err)
	}
	if _, err = h.repo.RequestThreadAction(t.Context(), h.owner, v.ID, "archive", ""); err != nil {
		t.Fatal(err)
	}
	view, _ = h.repo.GetThread(t.Context(), h.owner, v.ID)
	if view.Status != "archived" {
		t.Fatal(view.Status)
	}
}

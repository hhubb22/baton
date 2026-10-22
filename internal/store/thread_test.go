package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

type threadHarness struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	repo  *store.Store
	owner string
	src   protocol.Source
}

func newThreadHarness(t *testing.T) *threadHarness {
	t.Helper()
	pool := dbtest.Open(t)
	ctx := t.Context()
	repo := store.New(pool)
	owner := mustEmployee(t, ctx, pool, "thread-owner", "Thread").ID
	h := &threadHarness{t: t, ctx: ctx, pool: pool, repo: repo, owner: owner}
	h.src = h.addNode("Desk")
	return h
}
func (h *threadHarness) addNode(name string) protocol.Source {
	h.t.Helper()
	n := mustRegister(h.t, h.ctx, h.pool, h.repo, h.owner, name, node.RolePC, []string{"pi", "codex", "kiro"})
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: h.owner, NodeID: n.NodeID, CredentialID: n.Credential.ID, ConnID: mustUUID(h.t), Incarnation: mustUUID(h.t)}
	if err := h.repo.ConnectNode(h.ctx, src); err != nil {
		h.t.Fatal(err)
	}
	if err := h.repo.SyncNode(h.ctx, h.owner, n.NodeID, src.ConnID, name, node.SystemLinux, node.RolePC, n.Capabilities); err != nil {
		h.t.Fatal(err)
	}
	_, err := h.repo.SaveRuntimeReport(h.ctx, src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: []protocol.RuntimeAgent{
		{AgentType: "pi", Version: "1.3.0", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Steer: true, Stop: true, Resume: true}},
		{AgentType: "kiro", Version: "1", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Stop: true, Resume: true}},
	}})
	if err != nil {
		h.t.Fatal(err)
	}
	return src
}
func (h *threadHarness) input(key, nodeID string) store.CreateThreadInput {
	return store.CreateThreadInput{ClientThreadID: key, NodeID: nodeID, AgentType: "pi", WorkingDirectory: "/src/repo", Message: store.ThreadMessageInput{ClientMessageID: key + ":first", Content: "first"}}
}
func (h *threadHarness) create(key string) store.Thread {
	h.t.Helper()
	v, created, err := h.repo.CreateThread(h.ctx, h.owner, h.input(key, h.src.NodeID))
	if err != nil || !created {
		h.t.Fatalf("create: %v %v", created, err)
	}
	return v
}
func (h *threadHarness) report(id string, seq int64, kind string, edit func(*protocol.ThreadReport)) protocol.ThreadReport {
	h.t.Helper()
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: mustUUID(h.t), WorkerSeq: seq, Kind: kind}
	if edit != nil {
		edit(&r)
	}
	ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r)
	if err != nil || !ack.OK {
		h.t.Fatalf("report %s/%d: %+v %v", kind, seq, ack, err)
	}
	return r
}
func threadRejection(t *testing.T, err error, status int) {
	t.Helper()
	var e *store.ThreadError
	if !errors.As(err, &e) || e.Status != status {
		t.Fatalf("want %d: %v", status, err)
	}
}
func (h *threadHarness) count(sql string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.pool.QueryRow(h.ctx, sql, args...).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}
func (h *threadHarness) opened(v store.Thread) {
	h.report(v.ID, 1, "thread.opened", func(r *protocol.ThreadReport) { r.StorageGeneration = "generation"; r.NativeSessionID = "native" })
}
func (h *threadHarness) start(v store.Thread, seq, turn int64, message string) {
	h.report(v.ID, seq, "turn.started", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = turn; r.ClientMessageID = message })
	h.report(v.ID, seq+1, "message.sent", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = turn; r.ClientMessageID = message })
}
func TestThreadConcurrentIdempotencyDefaultsAndIsolation(t *testing.T) {
	h := newThreadHarness(t)
	in := h.input("stable", "")
	var wg sync.WaitGroup
	ids := make(chan string, 100)
	errs := make(chan error, 100)
	for range 100 {
		wg.Go(func() { v, _, err := h.repo.CreateThread(h.ctx, h.owner, in); ids <- v.ID; errs <- err })
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id string
	for next := range ids {
		if id != "" && id != next {
			t.Fatal("duplicate Thread")
		}
		id = next
	}
	v, err := h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || v.NodeID != h.src.NodeID || v.ExecutionTimeoutSeconds != 7200 {
		t.Fatalf("default: %+v %v", v, err)
	}
	if n := h.count(`SELECT count(*) FROM thread_outbox`); n != 2 {
		t.Fatalf("outbox %d", n)
	}
	in.Message.Content = "different"
	_, _, err = h.repo.CreateThread(h.ctx, h.owner, in)
	threadRejection(t, err, 409)
	other := mustEmployee(t, h.ctx, h.pool, "thread-other", "Other")
	if _, err = h.repo.GetThread(h.ctx, other.ID, id); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = h.repo.SendThreadMessage(h.ctx, other.ID, id, store.ThreadMessageInput{ClientMessageID: "x", Content: "secret"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = h.repo.RequestThreadAction(h.ctx, other.ID, id, "stop", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = h.repo.ThreadTimeline(h.ctx, other.ID, id, "", 20); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	page, err := h.repo.ListThreads(h.ctx, other.ID, store.ThreadFilter{})
	if err != nil || len(page.Threads) != 0 {
		t.Fatal("list leaked", err)
	}
	bad := h.input("foreign", h.src.NodeID)
	_, _, err = h.repo.CreateThread(h.ctx, other.ID, bad)
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatal("foreign node", err)
	}
	bad = h.input("outside", h.src.NodeID)
	bad.WorkingDirectory = "/src/../private"
	_, _, err = h.repo.CreateThread(h.ctx, h.owner, bad)
	threadRejection(t, err, 422)
	in = h.input("kiro", h.src.NodeID)
	in.AgentType = "kiro"
	k, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, k.ID, store.ThreadMessageInput{ClientMessageID: "steer", Content: "change", Mode: "steer"})
	threadRejection(t, err, 422)
	if _, err = h.repo.RevokeNode(h.ctx, h.owner, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	_, _, err = h.repo.CreateThread(h.ctx, h.owner, h.input("revoked-default", ""))
	threadRejection(t, err, 422)
}

func TestThreadMessagesReportsAndArchive(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("flow")
	h.opened(v)
	in := store.ThreadMessageInput{ClientMessageID: "next", Content: "queued"}
	for range 100 {
		if _, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, in); err != nil {
			t.Fatal(err)
		}
	}
	in.Content = "different"
	_, err := h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, in)
	threadRejection(t, err, 409)
	h.start(v, 2, 1, "flow:first")
	if _, err = h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "withdraw", "flow:first"); err == nil {
		t.Fatal("withdrew sent")
	}
	h.report(v.ID, 4, "message.queued", func(r *protocol.ThreadReport) { r.ClientMessageID = "next" })
	if _, err = h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "withdraw", "next"); err != nil {
		t.Fatal(err)
	}
	h.report(v.ID, 5, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = "next" })
	r := h.report(v.ID, 6, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Content = strings.Repeat("中", 20000) })
	ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r)
	if err != nil || !ack.OK {
		t.Fatal("duplicate", ack, err)
	}
	if n := h.count(`SELECT count(*) FROM thread_replies`); n != 1 {
		t.Fatal(n)
	}
	var content string
	var truncated bool
	var original int
	if err = h.pool.QueryRow(h.ctx, `SELECT content,truncated,original_bytes FROM thread_replies`).Scan(&content, &truncated, &original); err != nil || len(content) > 32768 || !utf8.ValidString(content) || !truncated || original != 60000 {
		t.Fatalf("reply bounds %d %v %d %v", len(content), truncated, original, err)
	}
	gap := r
	gap.EventID = mustUUID(t)
	gap.WorkerSeq = 8
	gap.Kind = "turn.ended"
	gap.Reason = "completed"
	ack, err = h.repo.SaveThreadReport(h.ctx, h.src, gap)
	if err != nil || ack.OK || ack.ExpectedWorkerSeq != 7 {
		t.Fatal("gap", ack, err)
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.Status != "running" || view.CurrentTurn == nil || view.LastWorkerSeq != 6 {
		t.Fatal(view, err)
	}
	if _, err = h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "archive", ""); err != nil {
		t.Fatal(err)
	}
	view, _ = h.repo.GetThread(h.ctx, h.owner, v.ID)
	if view.Status != "running" || view.ArchiveRequestedAt == nil {
		t.Fatal("early archive")
	}
	h.report(v.ID, 7, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Reason = "stopped"; r.QueueEmpty = true })
	view, err = h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || view.Status != "archived" || view.ArchivedAt == nil {
		t.Fatal(view, err)
	}
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "after", Content: "no"})
	threadRejection(t, err, 409)
	if _, err = h.repo.RequestThreadAction(h.ctx, h.owner, v.ID, "archive", ""); err != nil {
		t.Fatal("repeat archive", err)
	}
	var events []store.ThreadEvent
	cursor := ""
	for {
		page, err := h.repo.ThreadTimeline(h.ctx, h.owner, v.ID, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, page.Events...)
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	last := int64(0)
	replies := 0
	for _, e := range events {
		if e.ID <= last {
			t.Fatal("timeline order")
		}
		last = e.ID
		if e.Kind == "reply" {
			replies++
		}
	}
	if replies != 1 {
		t.Fatal("duplicate timeline", replies)
	}
	if _, err = h.pool.Exec(h.ctx, `DELETE FROM thread_events WHERE thread_id=$1`, v.ID); err == nil {
		t.Fatal("audit mutable")
	}
}

func TestThreadProjectInputsFollowTurnInitiator(t *testing.T) {
	h := newThreadHarness(t)
	p, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "Project"})
	if err != nil {
		t.Fatal(err)
	}
	in := h.input("project-thread", h.src.NodeID)
	in.ProjectID = p.ID
	in.CreatedBy = "project_agent"
	in.OriginConversationID = p.Conversation.ID
	in.OriginToolCallID = "create-thread"
	v, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil {
		t.Fatal(err)
	}
	h.opened(v)
	h.report(v.ID, 2, "message.withdrawn", func(r *protocol.ThreadReport) { r.ClientMessageID = "project-thread:first" })
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "employee-first", Content: "employee turn"}); err != nil {
		t.Fatal(err)
	}
	h.start(v, 3, 1, "employee-first")
	h.report(v.ID, 5, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Content = "employee reply" })
	h.report(v.ID, 6, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Reason = "completed"; r.QueueEmpty = true })
	if n := h.count(`SELECT count(*) FROM project_agent_input_queue`); n != 0 {
		t.Fatal("employee turn notified", n)
	}
	_, err = h.repo.SendThreadMessage(h.ctx, h.owner, v.ID, store.ThreadMessageInput{ClientMessageID: "pa", Content: "follow up", Sender: "project_agent", OriginToolCallID: "tool-1"})
	if err != nil {
		t.Fatal(err)
	}
	h.start(v, 7, 2, "pa")
	for seq := int64(9); seq <= 11; seq++ {
		h.report(v.ID, seq, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.Content = strings.Repeat("\t\"\\", 16000) })
	}
	if n := h.count(`SELECT count(*) FROM project_agent_input_queue WHERE wake_required`); n != 0 {
		t.Fatal("reply woke agent", n)
	}
	h.report(v.ID, 12, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.Reason = "completed"; r.QueueEmpty = true })
	if n := h.count(`SELECT count(*) FROM project_agent_input_queue WHERE source_type='thread_reply' AND NOT wake_required AND octet_length(payload::text)<=40960`); n != 3 {
		t.Fatal("reply inputs", n)
	}
	if n := h.count(`SELECT count(*) FROM project_agent_input_queue WHERE source_type='turn_ended' AND wake_required`); n != 1 {
		t.Fatal("end input", n)
	}
	var order string
	if err = h.pool.QueryRow(h.ctx, `SELECT string_agg(source_type,',' ORDER BY id) FROM project_agent_input_queue`).Scan(&order); err != nil || order != "thread_reply,thread_reply,thread_reply,turn_ended" {
		t.Fatal(order, err)
	}
	if n := h.count(`SELECT count(*) FROM thread_turns WHERE worker_turn_seq=2 AND initiator='project_agent' AND origin_tool_call_id='tool-1'`); n != 1 {
		t.Fatal("initiator", n)
	}
	if _, err = h.repo.GetThread(h.ctx, h.owner, v.ID); err != nil {
		t.Fatal(err)
	}
}

func TestThreadOutboxFairnessOrderLocksAndOffline(t *testing.T) {
	h := newThreadHarness(t)
	other := h.addNode("Other")
	for i := range 12 {
		h.create(fmt.Sprintf("backlog-%d", i))
	}
	b, _, err := h.repo.CreateThread(h.ctx, h.owner, h.input("other", other.NodeID))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	if _, err = tx.Exec(h.ctx, `SELECT id FROM thread_outbox WHERE thread_id=(SELECT id FROM threads WHERE client_thread_id='backlog-0') FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(h.ctx, `SELECT id FROM threads WHERE client_thread_id='backlog-1' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(h.ctx, time.Second)
	defer cancel()
	batch, err := h.repo.ClaimThreadCommands(ctx)
	if err != nil || len(batch) != 5 {
		t.Fatalf("claim %d %v", len(batch), err)
	}
	seenB := false
	var chosen store.ThreadIntent
	for _, in := range batch {
		if in.ThreadID == b.ID {
			seenB = true
		}
		var cmd protocol.ThreadCommand
		if json.Unmarshal(in.Envelope, new(protocol.Envelope)) != nil {
			t.Fatal("bad frame")
		}
		var env protocol.Envelope
		_ = json.Unmarshal(in.Envelope, &env)
		_ = json.Unmarshal(env.Body, &cmd)
		if cmd.Action != "open" {
			t.Fatal("message overtook open")
		}
		if in.NodeID == h.src.NodeID {
			chosen = in
		}
	}
	if !seenB {
		t.Fatal("backlog starved other node")
	}
	if err = tx.Rollback(h.ctx); err != nil {
		t.Fatal(err)
	}
	if err = h.repo.SaveThreadCommandResult(h.ctx, h.src, chosen.MessageID, protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: chosen.ThreadID, OK: true}); err != nil {
		t.Fatal(err)
	}
	h.opened(store.Thread{ID: chosen.ThreadID})
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	foundMessage := false
	for _, in := range batch {
		if in.ThreadID == chosen.ThreadID {
			foundMessage = true
			var env protocol.Envelope
			var cmd protocol.ThreadCommand
			_ = json.Unmarshal(in.Envelope, &env)
			_ = json.Unmarshal(env.Body, &cmd)
			if cmd.Action != "message" || cmd.Content != "first" {
				t.Fatal("wrong next command", cmd)
			}
		}
	}
	if !foundMessage {
		t.Fatal("ACK did not release next")
	}
	if err = h.repo.MarkOffline(h.ctx, other.NodeID, other.ConnID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE thread_outbox SET next_attempt_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range batch {
		if in.NodeID == other.NodeID {
			t.Fatal("offline dispatch")
		}
	}
	if err = h.repo.ConnectNode(h.ctx, other); err != nil {
		t.Fatal(err)
	}
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range batch {
		if in.NodeID == other.NodeID {
			t.Fatal("unsynced dispatch")
		}
	}
	if err = h.repo.SyncNode(h.ctx, h.owner, other.NodeID, other.ConnID, "Other", node.SystemLinux, node.RolePC, []string{"pi"}); err != nil {
		t.Fatal(err)
	}
	batch, err = h.repo.ClaimThreadCommands(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, in := range batch {
		found = found || in.ThreadID == b.ID
	}
	if !found {
		t.Fatal("reconnect did not dispatch")
	}
}

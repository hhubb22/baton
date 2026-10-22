package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

func threadToolArgs(t *testing.T, h *toolHarness) map[string]any {
	t.Helper()
	if _, err := h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(report,'{roots}','[{"root_id":"dev","path":"/registered"}]') WHERE node_id=$1`, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"node_id": h.src.NodeID, "agent_type": "codex", "working_directory": "/registered", "message": "检查仓库"}
}
func createProjectThread(t *testing.T, h *toolHarness) string {
	t.Helper()
	raw, bad := h.call(t, "threads.create", threadToolArgs(t, h))
	if bad {
		t.Fatal(string(raw))
	}
	var out struct {
		ID string `json:"thread_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.ID == "" {
		t.Fatal(string(raw), err)
	}
	return out.ID
}

func TestProjectThreadToolsAtomicCreationAndReplay(t *testing.T) {
	h := newToolHarness(t)
	req := h.save(t, "threads.create", threadToolArgs(t, h))
	h.repo.SetTaskCommitHook(func(context.Context) error { return errors.New("injected") })
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err == nil {
		t.Fatal("未回滚")
	}
	h.repo.SetTaskCommitHook(nil)
	for _, table := range []string{"threads", "thread_messages", "thread_outbox"} {
		if n := countRows(t, h.ctx, h.pool, "SELECT count(*) FROM "+table); n != 0 {
			t.Fatal(table, n)
		}
	}
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	first := out.(projectagent.Event)
	raw, bad := toolText(t, first)
	if bad {
		t.Fatal(string(raw))
	}
	var result struct {
		ID string `json:"thread_id"`
	}
	_ = json.Unmarshal(raw, &result)
	for range 3 {
		out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
		if err != nil || out.(projectagent.Event).Seq != first.Seq {
			t.Fatal(err)
		}
	}
	v, err := h.repo.GetThread(h.ctx, h.owner, result.ID)
	if err != nil || v.CreatedBy != "project_agent" || v.ProjectID != h.project.ID || v.OriginConversationID != h.project.Conversation.ID || v.OriginToolCallID != req.ToolCallID || len(v.PendingMessages) != 1 {
		t.Fatal(v, err)
	}
	key := "pa:" + h.project.Conversation.ID + ":" + req.ToolCallID
	m := v.PendingMessages[0]
	if v.ClientThreadID != key || m.ClientMessageID != key+":0" || m.Sender != "project_agent" || m.OriginToolCallID != req.ToolCallID {
		t.Fatal(v, m)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM thread_outbox`); n != 2 {
		t.Fatal(n)
	}
	h.seq = first.Seq
	for _, name := range []string{"threads.list", "threads.get", "threads.read"} {
		args := map[string]any{}
		if name != "threads.list" {
			args["thread_id"] = result.ID
		}
		raw, bad = h.call(t, name, args)
		if bad {
			t.Fatal(name, string(raw))
		}
	}
	args := threadToolArgs(t, h)
	args["agent_type"] = "shell"
	if _, bad = h.call(t, "threads.create", args); !bad {
		t.Fatal("threads.create 接受 shell")
	}
	args = threadToolArgs(t, h)
	args["unknown"] = true
	if _, bad = h.call(t, "threads.create", args); !bad {
		t.Fatal("接受未知参数")
	}
}

func TestProjectThreadPAA16EmployeeThenAgentTurnAndRead(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	startProjectShell(t, h, id)
	finishProjectShell(t, h, id, "initial-agent-reply", nil)
	baseline := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type IN ('thread_reply','turn_ended')`)
	v, err := h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || v.CreatedBy != "project_agent" {
		t.Fatal(v, err)
	}
	if _, err = h.repo.SendThreadMessage(h.ctx, h.owner, id, store.ThreadMessageInput{ClientMessageID: "employee-first", Content: "员工消息"}); err != nil {
		t.Fatal(err)
	}
	projectReport(t, h, v.ID, "turn.started", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.ClientMessageID = "employee-first" })
	projectReport(t, h, v.ID, "message.sent", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.ClientMessageID = "employee-first" })
	projectReport(t, h, v.ID, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.Content = "employee-reply" })
	projectReport(t, h, v.ID, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 2; r.Reason = "completed"; r.QueueEmpty = true })
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type IN ('thread_reply','turn_ended')`); n != baseline {
		t.Fatal("员工轮次进入队列", n)
	}
	raw, bad := h.call(t, "threads.send", map[string]any{"thread_id": v.ID, "message": "Agent 的下一轮"})
	if bad {
		t.Fatal(string(raw))
	}
	var result struct {
		Key string `json:"client_message_id"`
	}
	_ = json.Unmarshal(raw, &result)
	if !strings.HasPrefix(result.Key, "pa:"+h.project.Conversation.ID+":") {
		t.Fatal(result)
	}
	projectReport(t, h, v.ID, "turn.started", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 3; r.ClientMessageID = result.Key })
	projectReport(t, h, v.ID, "message.sent", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 3; r.ClientMessageID = result.Key })
	for i := 0; i < 3; i++ {
		projectReport(t, h, v.ID, "reply", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 3; r.Content = fmt.Sprintf("agent-reply-%d", i) })
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='thread_reply' AND wake_required`); n != 0 {
		t.Fatal("被动回复触发唤醒", n)
	}
	projectReport(t, h, v.ID, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 3; r.Reason = "completed"; r.QueueEmpty = true })
	raw, bad = h.call(t, "threads.read", map[string]any{"thread_id": v.ID, "after_turn": 2, "through_turn": 3})
	if bad {
		t.Fatal(string(raw))
	}
	text, _ := readToolPage(t, raw)
	if strings.Contains(text, "employee-reply") || !strings.Contains(text, "agent-reply-2") || !strings.Contains(text, `"initiator":"project_agent"`) {
		t.Fatal(text)
	}
	var previous int64
	rows, err := h.pool.Query(h.ctx, `SELECT id,source_type FROM project_agent_input_queue WHERE payload->>'thread_id'=$1 AND payload->>'worker_turn_seq'='3' ORDER BY id`, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for rows.Next() {
		var id int64
		var kind string
		if err = rows.Scan(&id, &kind); err != nil {
			t.Fatal(err)
		}
		if id <= previous {
			t.Fatal(id)
		}
		previous = id
		kinds = append(kinds, kind)
	}
	rows.Close()
	if strings.Join(kinds, ",") != "thread_reply,thread_reply,thread_reply,turn_ended" {
		t.Fatal(kinds)
	}
	if _, bad = h.call(t, "threads.stop", map[string]any{"thread_id": v.ID}); bad {
		t.Fatal("停止失败")
	}
	var actor, actorID string
	if err = h.pool.QueryRow(h.ctx, `SELECT actor,actor_id FROM thread_events WHERE thread_id=$1 AND kind='stop.requested' ORDER BY id DESC LIMIT 1`, v.ID).Scan(&actor, &actorID); err != nil || actor != "project_agent" || actorID != h.project.Agent.ID {
		t.Fatal(actor, actorID, err)
	}
}

func TestProjectThreadScopeAndSteerRejections(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	if _, bad := h.call(t, "threads.send", map[string]any{"thread_id": id, "message": "steer", "mode": "steer"}); !bad {
		t.Fatal("未声明 steer 能力仍接受")
	}
	other, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "其他"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE threads SET project_id=$2,origin_conversation_id=$3 WHERE id=$1`, id, other.ID, other.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"threads.send", "threads.stop", "threads.archive", "threads.get", "threads.read"} {
		args := map[string]any{"thread_id": id}
		if name == "threads.send" {
			args["message"] = "foreign"
		}
		if _, bad := h.call(t, name, args); !bad {
			t.Fatal(name)
		}
	}
}

func readThreadToolJSON(t *testing.T, h *toolHarness, name string, args map[string]any) []byte {
	t.Helper()
	var all strings.Builder
	for {
		raw, bad := h.call(t, name, args)
		if bad {
			t.Fatal(name, string(raw))
		}
		text, next := readToolPage(t, raw)
		all.WriteString(text)
		if next == 0 {
			break
		}
		args["offset"] = next
	}
	return []byte(all.String())
}

func TestProjectThreadListAndTurnPagination(t *testing.T) {
	h := newToolHarness(t)
	for range 21 {
		createProjectThread(t, h)
	}
	var first struct {
		Threads []store.Thread `json:"threads"`
		Next    string         `json:"next_after_id"`
	}
	raw := readThreadToolJSON(t, h, "threads.list", map[string]any{"max_bytes": 1024})
	if err := json.Unmarshal(raw, &first); err != nil || len(first.Threads) != 20 || first.Next != first.Threads[19].ID {
		t.Fatal(len(first.Threads), err)
	}
	for i := 1; i < len(first.Threads); i++ {
		if first.Threads[i-1].ID >= first.Threads[i].ID {
			t.Fatal("排序不稳定")
		}
	}
	var next struct {
		Threads []store.Thread `json:"threads"`
	}
	if err := json.Unmarshal(readThreadToolJSON(t, h, "threads.list", map[string]any{"after_id": first.Next}), &next); err != nil || len(next.Threads) != 1 {
		t.Fatal(next, err)
	}
	id := first.Threads[0].ID
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,started_at,ended_at,end_reason)
 SELECT md5($1::text||n::text)::uuid,$2,$1::uuid,n,'project_agent',clock_timestamp(),clock_timestamp(),'completed' FROM generate_series(1,22) n`, id, h.owner); err != nil {
		t.Fatal(err)
	}
	var page struct {
		Turns   []store.ThreadTurn `json:"turns"`
		Next    int64              `json:"next_after_turn"`
		Through int64              `json:"through_turn"`
	}
	if err := json.Unmarshal(readThreadToolJSON(t, h, "threads.read", map[string]any{"thread_id": id, "max_bytes": 1024}), &page); err != nil || len(page.Turns) != 20 || page.Next != 20 || page.Through != 22 {
		t.Fatal(page, err)
	}
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,started_at,ended_at,end_reason) VALUES($1,$2,$3,23,'employee',clock_timestamp(),clock_timestamp(),'completed')`, mustUUID(t), h.owner, id); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(readThreadToolJSON(t, h, "threads.read", map[string]any{"thread_id": id, "after_turn": page.Next, "through_turn": page.Through}), &page); err != nil || len(page.Turns) != 2 || page.Through != 22 || page.Next != 22 {
		t.Fatal(page, err)
	}
	if _, err := h.pool.Exec(h.ctx, `UPDATE threads SET status='idle' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, bad := h.call(t, "threads.archive", map[string]any{"thread_id": id}); bad {
		t.Fatal("归档失败")
	}
	var actor, actorID string
	if err := h.pool.QueryRow(h.ctx, `SELECT actor,actor_id FROM thread_events WHERE thread_id=$1 AND kind='archive.requested' ORDER BY id DESC LIMIT 1`, id).Scan(&actor, &actorID); err != nil || actor != "project_agent" || actorID != h.project.Agent.ID {
		t.Fatal(actor, actorID, err)
	}
}

func TestProjectThreadDeferredArchivePreservesActor(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	startProjectShell(t, h, id)
	if _, bad := h.call(t, "threads.archive", map[string]any{"thread_id": id}); bad {
		t.Fatal("归档失败")
	}
	projectReport(t, h, id, "turn.ended", func(r *protocol.ThreadReport) { r.WorkerTurnSeq = 1; r.Reason = "stopped"; r.QueueEmpty = true })
	view, err := h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || view.Status != "archived" {
		t.Fatal(view, err)
	}
	var actor, actorID string
	if err = h.pool.QueryRow(h.ctx, `SELECT actor,actor_id FROM thread_events WHERE thread_id=$1 AND kind='thread.archived' ORDER BY id DESC LIMIT 1`, id).Scan(&actor, &actorID); err != nil || actor != "project_agent" || actorID != h.project.Agent.ID {
		t.Fatal(actor, actorID, err)
	}
}

func TestProjectThreadInputDatabaseLimits(t *testing.T) {
	h := newToolHarness(t)
	for _, tc := range []struct {
		kind    string
		command bool
		limit   int
	}{{"thread_reply", false, 40960}, {"turn_ended", false, 4096}, {"turn_ended", true, 73728}} {
		for _, extra := range []int{0, 1} {
			var overhead int
			base := map[string]any{"content": ""}
			if tc.command {
				base["command_result"] = map[string]any{}
			}
			raw, _ := json.Marshal(base)
			if err := h.pool.QueryRow(h.ctx, `SELECT octet_length($1::jsonb::text)`, raw).Scan(&overhead); err != nil {
				t.Fatal(err)
			}
			base["content"] = strings.Repeat("x", tc.limit+extra-overhead)
			raw, _ = json.Marshal(base)
			_, err := h.pool.Exec(h.ctx, `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6)`, h.owner, h.project.Agent.ID, tc.kind, fmt.Sprintf("limit:%s:%t:%d", tc.kind, tc.command, extra), raw, make([]byte, 32))
			if (err != nil) != (extra == 1) {
				t.Fatal(tc, extra, err)
			}
		}
	}
}

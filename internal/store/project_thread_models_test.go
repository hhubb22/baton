package store_test

import (
	"encoding/json"
	"testing"

	"baton/internal/store"
)

func TestProjectThreadModelToolValidationAndPersistence(t *testing.T) {
	h := newToolHarness(t)
	args := threadToolArgs(t, h)
	agents := modelAgents()
	agents[0].AgentType = "codex"
	raw, err := json.Marshal(agents)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(report,'{agents}',$2::jsonb) WHERE node_id=$1`, h.src.NodeID, raw); err != nil {
		t.Fatal(err)
	}
	args["model"] = "missing"
	if _, bad := h.call(t, "threads.create", args); !bad {
		t.Fatal("unknown create model accepted")
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 0 {
		t.Fatal("invalid model created thread", n)
	}
	args["model"] = "model-b"
	out, bad := h.call(t, "threads.create", args)
	if bad {
		t.Fatal(string(out))
	}
	var result struct {
		ID string `json:"thread_id"`
	}
	if err = json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	v, err := h.repo.GetThread(h.ctx, h.owner, result.ID)
	if err != nil || v.Model != "model-b" {
		t.Fatal(v, err)
	}
	for _, a := range []map[string]any{
		{"thread_id": v.ID, "message": "next", "model": "missing"},
		{"thread_id": v.ID, "message": "next", "mode": "steer", "model": "model-a"},
	} {
		if _, bad = h.call(t, "threads.send", a); !bad {
			t.Fatal("invalid model request accepted", a)
		}
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM thread_messages`); n != 1 {
		t.Fatal("rejected tools persisted messages", n)
	}
	if out, bad = h.call(t, "threads.send", map[string]any{"thread_id": v.ID, "message": "next", "model": "model-a"}); bad {
		t.Fatal(string(out))
	}
	v, err = h.repo.GetThread(h.ctx, h.owner, v.ID)
	if err != nil || v.Model != "model-b" || len(v.PendingMessages) != 2 || v.PendingMessages[1].Model != "model-a" {
		t.Fatal(v, err)
	}
	args["agent_type"] = "kiro"
	out, bad = h.call(t, "threads.create", args)
	if bad || json.Unmarshal(out, &result) != nil {
		t.Fatal(string(out))
	}
	if _, bad = h.call(t, "threads.send", map[string]any{"thread_id": result.ID, "message": "next", "model": "model-a"}); !bad {
		t.Fatal("unsupported model switch accepted")
	}
	if out, bad = h.call(t, "threads.send", map[string]any{"thread_id": result.ID, "message": "next"}); bad {
		t.Fatal(string(out))
	}
}

func TestThreadEmployeeProjectAssignmentAndPersonalToolScope(t *testing.T) {
	h := newToolHarness(t)
	_ = threadToolArgs(t, h)
	in := store.CreateThreadInput{ClientThreadID: "personal", NodeID: h.src.NodeID, AgentType: "codex", WorkingDirectory: "/registered", ProjectID: h.project.ID, Message: store.ThreadMessageInput{ClientMessageID: "personal:first", Content: "hello"}}
	_, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	threadRejection(t, err, 400)
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 0 {
		t.Fatal("employee assigned project", n)
	}
	in.ProjectID = ""
	personal, _, err := h.repo.CreateThread(h.ctx, h.owner, in)
	if err != nil || personal.ProjectID != "" || personal.OriginConversationID != "" || personal.OriginToolCallID != "" {
		t.Fatal(personal, err)
	}
	for _, name := range []string{"threads.get", "threads.read", "threads.send", "threads.stop", "threads.archive"} {
		args := map[string]any{"thread_id": personal.ID}
		if name == "threads.send" {
			args["message"] = "next"
		}
		if _, bad := h.call(t, name, args); !bad {
			t.Fatal("personal thread accessible to project tool", name)
		}
	}
	var count int
	if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM thread_messages WHERE thread_id=$1`, personal.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	// 能力缺少模型列表时，工具只能省略模型以使用设备默认值。
	if _, err = h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(report,'{agents}',$2::jsonb) WHERE node_id=$1`, h.src.NodeID, `[{
 "agent_type":"codex","version":"1","status":"available","default_model":"default-only","models":[],"capabilities":{"create":true}}]`); err != nil {
		t.Fatal(err)
	}
	args := threadToolArgs(t, h)
	args["model"] = "default-only"
	if _, bad := h.call(t, "threads.create", args); !bad {
		t.Fatal("explicit unreported model accepted")
	}
	delete(args, "model")
	out, bad := h.call(t, "threads.create", args)
	if bad {
		t.Fatal(string(out))
	}
	var result struct {
		ID string `json:"thread_id"`
	}
	if err = json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, result.ID)
	if err != nil || view.Model != "default-only" {
		t.Fatal(view, err)
	}
}

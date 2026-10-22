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
	"github.com/jackc/pgx/v5/pgxpool"
)

type toolHarness struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	repo    *store.Store
	owner   string
	project projectagent.Project
	src     protocol.Source
	req     protocol.ProjectRuntimeRequest
	seq     int64
	counter int
}

func newToolHarness(t *testing.T) *toolHarness {
	t.Helper()
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "tools", "执行工具")
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
	raw, err := repo.ProjectRuntime(ctx, src, req)
	if err != nil {
		t.Fatal(err)
	}
	seq := raw.(projectagent.Claim).Event.Seq
	return &toolHarness{ctx, pool, repo, owner, p, src, req, seq, 0}
}
func (h *toolHarness) save(t *testing.T, name string, args any) protocol.ProjectRuntimeRequest {
	t.Helper()
	h.counter++
	id := fmt.Sprintf("call-%d", h.counter)
	raw, _ := json.Marshal(args)
	payload, _ := json.Marshal(map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": json.RawMessage(raw)}}}})
	req := h.req
	req.Operation = "append_event"
	req.LastSeq = h.seq
	req.ClientEventID = id
	req.Payload = payload
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Event).Seq
	req.Operation = "call_tool"
	req.LastSeq = h.seq
	req.ToolCallID = id
	req.ToolName = name
	req.Arguments = raw
	req.Payload = nil
	return req
}
func toolText(t *testing.T, e projectagent.Event) (json.RawMessage, bool) {
	t.Helper()
	var p struct {
		Message struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil || len(p.Message.Content) != 1 {
		t.Fatal("工具结果格式无效", err)
	}
	text := json.RawMessage(p.Message.Content[0].Text)
	if len(text) > 32<<10 || len(e.Payload) > 32<<10 {
		t.Fatalf("输出超限 %d", len(text))
	}
	return text, p.Message.IsError
}
func (h *toolHarness) call(t *testing.T, name string, args any) (json.RawMessage, bool) {
	t.Helper()
	req := h.save(t, name, args)
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	e := out.(projectagent.Event)
	h.seq = e.Seq
	return toolText(t, e)
}
func readToolPage(t *testing.T, raw []byte) (string, int) {
	t.Helper()
	var page struct {
		Text string `json:"text"`
		Next int    `json:"next_offset"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	return page.Text, page.Next
}

func TestProjectToolsTransactionRecoveryAndLease(t *testing.T) {
	h := newToolHarness(t)
	req := h.save(t, "threads.create", threadToolArgs(t, h))
	h.repo.SetCommitHook(func(context.Context) error { return errors.New("故障注入：结果提交前") })
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err == nil {
		t.Fatal("提交故障未生效")
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 0 {
		t.Fatal("回滚保留了 Thread")
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM conversation_events WHERE kind='tool_result'`); n != 0 {
		t.Fatal("回滚保留了结果")
	}
	h.repo.SetCommitHook(nil)
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	first := out.(projectagent.Event)
	for range 3 {
		out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
		if err != nil || out.(projectagent.Event).Seq != first.Seq {
			t.Fatal("重放分叉", err)
		}
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 1 {
		t.Fatalf("Thread 数 %d", n)
	}
	if _, err := h.pool.Exec(h.ctx, `UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, projectagent.ErrLeaseLost) {
		t.Fatal("过期租约重放被接受", err)
	}
}

func TestProjectToolsAuthorizationAndSavedCall(t *testing.T) {
	h := newToolHarness(t)
	unsaved := h.req
	unsaved.Operation = "call_tool"
	unsaved.LastSeq = h.seq
	unsaved.ToolCallID = "unsaved"
	unsaved.ToolName = "threads.create"
	unsaved.Arguments, _ = json.Marshal(threadToolArgs(t, h))
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, unsaved); !errors.Is(err, projectagent.ErrInvalid) {
		t.Fatal("未保存调用被执行", err)
	}
	for _, name := range []string{"nodes.exec", "inbox.ask", "filesystem.write", "threads.create"} {
		args := map[string]any{"employee_id": mustID(t), "project_id": mustID(t)}
		raw, bad := h.call(t, name, args)
		if !bad {
			t.Fatal(name, string(raw))
		}
	}
	args := threadToolArgs(t, h)
	args["agent_type"] = "shell"
	if raw, bad := h.call(t, "threads.create", args); !bad {
		t.Fatal(string(raw))
	}
	req := h.save(t, "threads.create", threadToolArgs(t, h))
	req.Arguments = json.RawMessage(`{}`)
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatal("替换已保存参数被接受", err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 0 {
		t.Fatal("越权创建 Thread")
	}
}

func TestProjectToolsRejectRetiredTaskTools(t *testing.T) {
	h := newToolHarness(t)
	for _, name := range []string{"tasks.dispatch", "tasks.list", "tasks.get", "tasks.cancel"} {
		if raw, bad := h.call(t, name, map[string]any{}); !bad {
			t.Fatal("接受旧工具", name, string(raw))
		}
	}
	if n := countRows(t, h.ctx, h.pool, "SELECT count(*) FROM threads"); n != 0 {
		t.Fatal("旧工具产生了 Thread", n)
	}
}

func TestProjectToolsReadAllAndBoundedOutput(t *testing.T) {
	h := newToolHarness(t)
	content := strings.Repeat("记忆\"\\\n", 3000)
	raw, bad := h.call(t, "memory.write", map[string]any{"title": "偏好", "content": content, "expected_revision": 0})
	if bad {
		t.Fatal(string(raw))
	}
	var memory struct {
		ID string `json:"entry_id"`
	}
	_ = json.Unmarshal(raw, &memory)
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='memory_updated'`); n != 0 {
		t.Fatal("Agent 写记忆产生被动通知")
	}
	var combined strings.Builder
	offset := 0
	for {
		raw, bad = h.call(t, "memory.read", map[string]any{"entry_id": memory.ID, "revision": 1, "offset": offset})
		if bad {
			t.Fatal(string(raw))
		}
		part, next := readToolPage(t, raw)
		combined.WriteString(part)
		if next == 0 {
			break
		}
		offset = next
	}
	var got projectagent.Memory
	if err := json.Unmarshal([]byte(combined.String()), &got); err != nil || got.Content != content {
		t.Fatal("未读回完整记忆", err)
	}
	for _, name := range []string{"memory.search", "history.search", "history.read", "devices.list", "threads.list"} {
		raw, bad = h.call(t, name, map[string]any{})
		if bad {
			t.Fatal(name, string(raw))
		}
		text, _ := readToolPage(t, raw)
		if text == "" {
			t.Fatal(name)
		}
	}
	raw, bad = h.call(t, "memory.write", map[string]any{"entry_id": memory.ID, "title": "偏好", "content": "覆盖", "expected_revision": 0})
	if !bad {
		t.Fatal("版本冲突未返回错误", string(raw))
	}
	var conflict struct {
		CurrentRevision int64 `json:"current_revision"`
	}
	if err := json.Unmarshal(raw, &conflict); err != nil || conflict.CurrentRevision != 1 {
		t.Fatal("长记忆冲突缺少当前版本", string(raw), err)
	}
}

func TestProjectToolsSequentialCallsAndConcurrentReplay(t *testing.T) {
	h := newToolHarness(t)
	args := threadToolArgs(t, h)
	payload, _ := json.Marshal(map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": "first", "name": "threads.create", "arguments": args}, map[string]any{"type": "toolCall", "id": "second", "name": "threads.list", "arguments": map[string]any{}}}}})
	req := h.req
	req.Operation = "append_event"
	req.ClientEventID = "two-calls"
	req.LastSeq = h.seq
	req.Payload = payload
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Event).Seq
	req.Operation = "call_tool"
	req.Payload = nil
	req.LastSeq = h.seq
	req.ToolCallID = "second"
	req.ToolName = "threads.list"
	req.Arguments = json.RawMessage(`{}`)
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatal("工具乱序执行", err)
	}
	req.ToolCallID = "first"
	req.ToolName = "threads.create"
	req.Arguments, _ = json.Marshal(args)
	results := make(chan projectagent.Event, 2)
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
			if err == nil {
				results <- out.(projectagent.Event)
			}
			errs <- err
		}()
	}
	for range 2 {
		if err = <-errs; err != nil {
			t.Fatal(err)
		}
	}
	first, second := <-results, <-results
	if first.Seq != second.Seq {
		t.Fatal("并发结果分叉")
	}
	req.LastSeq = first.Seq
	req.ToolCallID = "second"
	req.ToolName = "threads.list"
	req.Arguments = json.RawMessage(`{}`)
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || out.(projectagent.Event).Seq != first.Seq+1 {
		t.Fatal("顺序结果不连续", err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM threads`); n != 1 {
		t.Fatal(n)
	}
	duplicate := h.req
	duplicate.Operation = "append_event"
	duplicate.ClientEventID = "reused-tool-id"
	duplicate.LastSeq = first.Seq + 1
	duplicate.Payload = payload
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, duplicate); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatal("跨消息复用工具标识", err)
	}
}

func TestProjectToolsCrossProjectResourcesAreInvisible(t *testing.T) {
	h := newToolHarness(t)
	other, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "另一个项目"})
	if err != nil {
		t.Fatal(err)
	}
	entry := mustID(t)
	if _, err = h.repo.WriteProjectMemory(h.ctx, h.owner, other.ID, entry, projectagent.MemoryWrite{Title: "私有记忆", Content: "另一项目", Author: "user"}); err != nil {
		t.Fatal(err)
	}
	raw, bad := h.call(t, "memory.read", map[string]any{"entry_id": entry})
	if !bad {
		t.Fatal("跨项目记忆泄漏", string(raw))
	}
}

func TestProjectToolsHistoryReadPreservesOriginalEvents(t *testing.T) {
	h := newToolHarness(t)
	original := strings.Repeat("压缩前的原文\"\\\n", 3000)
	savedPayload, _ := json.Marshal(map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": original}}}})
	req := h.req
	req.Operation = "append_event"
	req.ClientEventID = "original-history"
	req.LastSeq = h.seq
	req.Payload = savedPayload
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Event).Seq
	originalSeq := h.seq
	compact, _ := json.Marshal(map[string]any{"through_seq": originalSeq, "summary": "历史摘要"})
	if _, err = h.pool.Exec(h.ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES($1,$2,$3,'compaction',$4)`, h.project.Conversation.ID, h.seq+1, h.owner, compact); err != nil {
		t.Fatal(err)
	}
	h.seq++
	if _, err = h.pool.Exec(h.ctx, `UPDATE conversations SET next_seq=$2,compaction_seq=$3 WHERE id=$1`, h.project.Conversation.ID, h.seq+1, h.seq); err != nil {
		t.Fatal(err)
	}
	var combined strings.Builder
	offset := 0
	for {
		raw, bad := h.call(t, "history.read", map[string]any{"after_seq": originalSeq - 1, "through_seq": originalSeq, "offset": offset})
		if bad {
			t.Fatal(string(raw))
		}
		part, next := readToolPage(t, raw)
		combined.WriteString(part)
		if next == 0 {
			break
		}
		offset = next
	}
	var page struct {
		Events []projectagent.Event `json:"events"`
	}
	if err = json.Unmarshal([]byte(combined.String()), &page); err != nil || len(page.Events) != 1 {
		t.Fatal(err)
	}
	var p struct {
		Message struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err = json.Unmarshal(page.Events[0].Payload, &p); err != nil || p.Message.Content[0].Text != original {
		t.Fatal("压缩前原文读取不完整", err)
	}
}

package gateway_test

import (
	"context"
	"strings"
	"testing"

	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/protocol"
)

func TestInboxRealProcessesToolsValidationAndRecovery(t *testing.T) {
	p := startProjectRuntimeStack(t)
	st := p.stack
	ctx := context.Background()
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "inbox-input")
	runID, _ := waitProjectRun(t, p, project, "")
	var claim projectagent.Claim
	if r := p.call(t, runID, "claim", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, &claim); !r.OK || claim.Event == nil {
		t.Fatal(r)
	}
	seq := claim.Event.Seq
	invoke := func(id, name string, args any) projectagent.Event {
		t.Helper()
		var saved, result projectagent.Event
		if r := p.call(t, runID, id+"-save", assistantToolRequest(id, name, args, seq), &saved); !r.OK {
			t.Fatal(r)
		}
		seq = saved.Seq
		if r := p.call(t, runID, id+"-call", toolProcessRequest(id, name, args, seq), &result); !r.OK {
			t.Fatal(r)
		}
		seq = result.Seq
		return result
	}
	// 用不同 Markdown 语法通过真实 Runtime → batond → Coordinator call_tool。
	for i, content := range []string{strings.Repeat("x", 32769), "[链接](http://example.org)", "[引用][r]\n\n[r]: javascript:alert", "<http://example.org>", "http://example.org"} {
		id := string(rune('a' + i))
		result := invoke("invalid-"+id, "inbox.ask", map[string]any{"title": "错误内容", "content": content, "allow_text": true})
		if !processToolError(t, result) {
			t.Fatal("不合规内容被接受", i)
		}
	}
	var count int
	if err := st.pool.QueryRow(ctx, `SELECT count(*) FROM attention_requests WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("错误调用生成事项", count, err)
	}
	args := map[string]any{"title": "检查结果", "content": "[证据](https://example.org)", "options": []inbox.Option{{ID: "investigate", Label: "调查"}}, "allow_text": true}
	var saved projectagent.Event
	if r := p.call(t, runID, "ask-save", assistantToolRequest("ask-once", "inbox.ask", args, seq), &saved); !r.OK {
		t.Fatal(r)
	}
	seq = saved.Seq
	request := toolProcessRequest("ask-once", "inbox.ask", args, seq)
	// 业务和 tool_result 已提交，Runtime 尚未收到结果时崩溃。
	runtimeFaultCommand(t, p, runID, "fault-inbox", "before_result", request)
	killRuntimeAtBoundary(t, p, runID, "fault-inbox")
	recovered, _ := waitProjectRun(t, p, project, runID)
	runID = recovered
	var boot projectagent.Bootstrap
	if r := p.call(t, runID, "bootstrap", protocol.ProjectRuntimeRequest{Operation: "bootstrap"}, &boot); !r.OK {
		t.Fatal(r)
	}
	request.LastSeq = boot.LastSeq
	var result projectagent.Event
	for _, id := range []string{"ask-replay", "ask-replay-again"} {
		if r := p.call(t, runID, id, request, &result); !r.OK || processToolError(t, result) {
			t.Fatal(r)
		}
	}
	seq = result.Seq
	var requestID string
	var results int
	if err := st.pool.QueryRow(ctx, `SELECT count(*),min(id::text) FROM attention_requests WHERE project_id=$1`, project.ID).Scan(&count, &requestID); err != nil || count != 1 {
		t.Fatal("重发产生第二个事项", count, err)
	}
	if err := st.pool.QueryRow(ctx, `SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND tool_call_id='ask-once' AND kind='tool_result'`, project.Conversation.ID).Scan(&results); err != nil || results != 1 {
		t.Fatal("重复工具结果", results, err)
	}
	for _, call := range []struct {
		id, name string
		args     any
	}{
		{"list", "inbox.list", map[string]any{}},
		{"get", "inbox.get", map[string]any{"request_id": requestID}},
		{"withdraw", "inbox.withdraw", map[string]any{"request_id": requestID, "reason": "情况已变化"}},
	} {
		if result = invoke(call.id, call.name, call.args); processToolError(t, result) {
			t.Fatal(string(result.Payload))
		}
	}
	var item inbox.Request
	runtimeProjectHTTP(t, st, "GET", "/api/v1/attention-requests/"+requestID, nil, &item, 200)
	if item.State != "withdrawn" {
		t.Fatal(item.State)
	}
	if err := st.pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='attention_answer'`, project.Agent.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("撤回写入输入", count, err)
	}
	p.send(t, runID, "finish", protocol.ProjectRuntimeRequest{Operation: "finish", Reason: "fixture_complete"})
	waitProjectRunEnded(t, p, runID)
	t.Log("真实进程：Markdown 错误无事项；提交后杀 Runtime 并恢复重发仅一事项/结果；四个 inbox 工具均可调用")
}

package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func inboxArgs() map[string]any {
	return map[string]any{"title": "需要用户决定", "content": "[证据](https://example.org/result)", "options": []inbox.Option{{ID: "continue", Label: "继续", Recommended: true}, {ID: "stop", Label: "停止"}}, "allow_text": true}
}
func askInbox(t *testing.T, h *toolHarness) inbox.Request {
	t.Helper()
	raw, bad := h.call(t, "inbox.ask", inboxArgs())
	if bad {
		t.Fatal(string(raw))
	}
	var out struct {
		ID string `json:"request_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	r, err := h.repo.AttentionRequest(h.ctx, h.owner, out.ID)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func answerInbox(key string) inbox.Handle {
	return inbox.Handle{ExpectedVersion: 1, ClientRequestID: key, OptionID: "continue", Text: "请调查证据"}
}
func TestInboxToolsIdempotencyLimitAndScope(t *testing.T) {
	h := newToolHarness(t)
	req := h.save(t, "inbox.ask", inboxArgs())
	h.repo.SetTaskCommitHook(func(context.Context) error { return errors.New("事务回滚") })
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err == nil {
		t.Fatal("故障未回滚")
	}
	if countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests`) != 0 {
		t.Fatal("事项残留")
	}
	h.repo.SetTaskCommitHook(nil)
	first, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = first.(projectagent.Event).Seq
	if repeated, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil || repeated.(projectagent.Event).Seq != h.seq {
		t.Fatal("重发分叉", err)
	}
	// 系统事项不占提案数量。
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	b := inbox.Binding{EmployeeID: h.owner, ProjectID: h.project.ID, AgentID: h.project.Agent.ID, ConversationID: h.project.Conversation.ID}
	if err = inbox.CreateSystem(h.ctx, tx, b, inbox.ProjectNeedsAttention, h.project.ID, "Project 需要处理", "模型失败"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	for range 9 {
		askInbox(t, h)
	}
	if _, bad := h.call(t, "inbox.ask", inboxArgs()); !bad {
		t.Fatal("接受第 11 个提案")
	}
	other, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "另一个 Project"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err = h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = inbox.CreateAgent(h.ctx, tx, inbox.Binding{EmployeeID: h.owner, ProjectID: other.ID, AgentID: other.Agent.ID, ConversationID: other.Conversation.ID}, "other", inbox.Ask{Title: "其他 Project", AllowText: true})
	if err != nil {
		t.Fatal("上限算到其他 Project", err)
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	page, err := h.repo.Inbox(h.ctx, h.owner, "open", "")
	if err != nil || page.OpenCount != 12 {
		t.Fatalf("数量 %d %v", page.OpenCount, err)
	}
	for _, name := range []string{"inbox.get", "inbox.withdraw"} {
		args := map[string]any{"request_id": page.Requests[0].ID}
		if name == "inbox.withdraw" {
			args["reason"] = "撤回"
		}
		if _, bad := h.call(t, name, args); !bad {
			t.Fatal("跨 Project 或多余字段被接受", name)
		}
	}
	if _, bad := h.call(t, "inbox.list", map[string]any{}); bad {
		t.Fatal("列表失败")
	}
	t.Log("同一 tool_call_id 仅一事项；系统事项不占 10 个配额；配额按 Project 隔离")
}
func TestInboxConcurrentAnswersAndWithdrawal100Rounds(t *testing.T) {
	h := newToolHarness(t)
	first := askInbox(t, h)
	// 两个独立 Store 从连接池取得不同连接竞争同一事项。
	repos := []*store.Store{h.repo, store.New(h.pool)}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := range 2 {
		go func(i int) {
			<-start
			_, err := repos[i].HandleAttentionRequest(h.ctx, h.owner, first.ID, answerInbox(fmt.Sprintf("answer-%d", i)), false)
			results <- err
		}(i)
	}
	close(start)
	wins := 0
	for range 2 {
		err := <-results
		var c *inbox.Conflict
		if err == nil {
			wins++
		} else if !errors.As(err, &c) || c.Current.State != "answered" {
			t.Fatal(err)
		}
	}
	if wins != 1 || countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='attention_answer'`) != 1 {
		t.Fatal("回答未保持唯一")
	}
	current, err := h.repo.AttentionRequest(h.ctx, h.owner, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, first.ID, answerInbox(current.Resolution.ClientRequestID), false); err != nil {
		t.Fatal("请求重试失败", err)
	}
	stale := askInbox(t, h)
	v := answerInbox("stale")
	v.ExpectedVersion = 99
	var conflict *inbox.Conflict
	if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, stale.ID, v, false); !errors.As(err, &conflict) || conflict.Current.Version != 1 {
		t.Fatal("未返回当前版本", err)
	}
	if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, stale.ID, answerInbox("clean"), true); err == nil {
		t.Fatal("close 接受额外回答内容")
	}
	for i := range 100 {
		r := askInbox(t, h)
		req := h.save(t, "inbox.withdraw", map[string]any{"request_id": r.ID, "reason": "情况变化"})
		start = make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		var answerErr, withdrawErr error
		var tool projectagent.Event
		go func() {
			defer wg.Done()
			<-start
			_, answerErr = repos[1].HandleAttentionRequest(h.ctx, h.owner, r.ID, answerInbox(fmt.Sprintf("race-%d", i)), false)
		}()
		go func() {
			defer wg.Done()
			<-start
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
			withdrawErr = err
			if err == nil {
				tool = out.(projectagent.Event)
			}
		}()
		close(start)
		wg.Wait()
		if withdrawErr != nil {
			t.Fatal(withdrawErr)
		}
		h.seq = tool.Seq
		if _, bad := toolText(t, tool); bad {
			t.Fatal("撤回工具失败")
		}
		current, err := h.repo.AttentionRequest(h.ctx, h.owner, r.ID)
		if err != nil {
			t.Fatal(err)
		}
		var inputs int
		if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM project_agent_input_queue WHERE source_key=$1`, "attention:"+r.ID+":resolution").Scan(&inputs); err != nil {
			t.Fatal(err)
		}
		switch current.State {
		case "answered":
			if answerErr != nil || inputs != 1 {
				t.Fatalf("回答获胜 inputs=%d %v", inputs, answerErr)
			}
		case "withdrawn":
			if !errors.As(answerErr, &conflict) || inputs != 0 {
				t.Fatalf("撤回获胜 inputs=%d %v", inputs, answerErr)
			}
		default:
			t.Fatal(current.State)
		}
	}
	t.Log("两个连接回答仅一次生效；回答与撤回并发 100 轮，每轮只有一个终态，撤回不写输入")
}
func TestInboxOfflinePauseArchiveAndRollback(t *testing.T) {
	h := newToolHarness(t)
	first := askInbox(t, h)
	if _, err := h.pool.Exec(h.ctx, `UPDATE node_presence SET online=false,synced=false`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.repo.HandleAttentionRequest(h.ctx, h.owner, first.ID, answerInbox("offline"), false); err != nil {
		t.Fatal("离线回答", err)
	}
	// 创建后暂停，再接受回答；暂停期间既有运行释放且新输入不能放置。
	if _, err := h.pool.Exec(h.ctx, `UPDATE node_presence SET online=true,synced=true`); err != nil {
		t.Fatal(err)
	}
	paused := askInbox(t, h)
	status := "paused"
	if _, err := h.repo.PatchProject(h.ctx, h.owner, h.project.ID, projectagent.Patch{Status: &status}); err != nil {
		t.Fatal(err)
	}
	h.repo.SetTaskCommitHook(func(context.Context) error { return errors.New("回滚回答") })
	if _, err := h.repo.HandleAttentionRequest(h.ctx, h.owner, paused.ID, answerInbox("paused"), false); err == nil {
		t.Fatal("未注入回滚")
	}
	if got, err := h.repo.AttentionRequest(h.ctx, h.owner, paused.ID); err != nil || got.State != "open" {
		t.Fatal("回滚残留", err)
	}
	h.repo.SetTaskCommitHook(nil)
	if _, err := h.repo.HandleAttentionRequest(h.ctx, h.owner, paused.ID, answerInbox("paused"), false); err != nil {
		t.Fatal(err)
	}
	if err := h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM agent_runs WHERE state IN ('starting','running')`); n != 0 {
		t.Fatal("暂停仍启动", n)
	}
	status = "active"
	if _, err := h.repo.PatchProject(h.ctx, h.owner, h.project.ID, projectagent.Patch{Status: &status}); err != nil {
		t.Fatal(err)
	}
	if err := h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	var runID string
	if err := h.pool.QueryRow(h.ctx, `SELECT lease_run_id::text FROM project_agents WHERE id=$1`, h.project.Agent.ID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	h.req = runtimeRequest(t, h.ctx, h.pool, h.project.Agent.ID, "claim_inputs")
	h.req.LastSeq = h.seq
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, h.req)
	if err != nil {
		t.Fatal(err)
	}
	claim := out.(projectagent.Claim)
	if claim.Event == nil || !strings.Contains(string(claim.Event.Payload), "attention_answer") {
		t.Fatal("恢复未领取回答")
	}
	h.seq = claim.Event.Seq
	ids := []string{}
	for range 3 {
		ids = append(ids, askInbox(t, h).ID)
	}
	status = "archived"
	if _, err := h.repo.PatchProject(h.ctx, h.owner, h.project.ID, projectagent.Patch{Status: &status}); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		r, err := h.repo.AttentionRequest(h.ctx, h.owner, id)
		if err != nil || r.State != "withdrawn" || r.WithdrawReason != "Project 已归档" {
			t.Fatal("归档未撤回", r, err)
		}
	}
	t.Log("离线与暂停回答成功；暂停不放置，恢复领取 attention_answer；归档 3 个事项均撤回")
}
func TestInboxThreadAssociationAndTaskIsolation(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	args := inboxArgs()
	args["thread_id"] = id
	raw, bad := h.call(t, "inbox.ask", args)
	if bad {
		t.Fatal(string(raw))
	}
	var created struct {
		ID string `json:"request_id"`
	}
	_ = json.Unmarshal(raw, &created)
	r, err := h.repo.AttentionRequest(h.ctx, h.owner, created.ID)
	if err != nil || r.ThreadID != id {
		t.Fatal(r, err)
	}
	encoded, _ := json.Marshal(r)
	if strings.Contains(string(encoded), "task_result") {
		t.Fatal(string(encoded))
	}
	page, err := h.repo.RelatedAttentionRequests(h.ctx, h.owner, "all", "", h.project.ID, id)
	if err != nil || len(page.Requests) != 1 || page.Requests[0].ID != r.ID {
		t.Fatal(page, err)
	}
	other, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "其他"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE threads SET project_id=$2,origin_conversation_id=$3 WHERE id=$1`, id, other.ID, other.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	if _, bad = h.call(t, "inbox.ask", args); !bad {
		t.Fatal("接受跨 Project Thread")
	}
	taskID := h.dispatch(t)
	if _, err = h.repo.RequestCancel(h.ctx, h.owner, taskID); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests WHERE source='system'`); n != 0 {
		t.Fatal("旧任务生成系统事项", n)
	}
}

func TestInboxContentPagingThreadOwnershipAndEscapedReply(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	other, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "其他 Project"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE threads SET project_id=$2,origin_conversation_id=$3 WHERE id=$1`, id, other.ID, other.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	args := inboxArgs()
	args["thread_id"] = id
	if _, bad := h.call(t, "inbox.ask", args); !bad {
		t.Fatal("接受其他 Project 的任务引用")
	}
	args = inboxArgs()
	content := strings.Repeat("文", 10922) + "ab"
	args["content"] = content
	raw, bad := h.call(t, "inbox.ask", args)
	if bad {
		t.Fatal(string(raw))
	}
	var out struct {
		ID string `json:"request_id"`
	}
	_ = json.Unmarshal(raw, &out)
	var all strings.Builder
	offset := 0
	for {
		raw, bad = h.call(t, "inbox.get", map[string]any{"request_id": out.ID, "offset": offset, "max_bytes": 32768})
		if bad {
			t.Fatal(string(raw))
		}
		text, next := readToolPage(t, raw)
		all.WriteString(text)
		if next == 0 {
			break
		}
		offset = next
	}
	var restored inbox.Request
	if err = json.Unmarshal([]byte(all.String()), &restored); err != nil || restored.Content != content {
		t.Fatal("分页未恢复 32 KiB Markdown", err)
	}
	reply := answerInbox("escaped-4k")
	reply.Text = strings.Repeat("\x01", 4096)
	answered, err := h.repo.HandleAttentionRequest(h.ctx, h.owner, out.ID, reply, false)
	if err != nil || answered.Resolution.Text != reply.Text {
		t.Fatal("合法 4 KiB 回复转义后不能保存", err)
	}
	var saved []byte
	if err = h.pool.QueryRow(h.ctx, `SELECT payload FROM project_agent_input_queue WHERE source_key=$1`, "attention:"+out.ID+":resolution").Scan(&saved); err != nil || len(saved) > 32768 || !strings.Contains(string(saved), `\u0001`) {
		t.Fatal("转义后的输入未保存", err)
	}
	if raw, bad = h.call(t, "inbox.withdraw", map[string]any{"request_id": out.ID, "reason": "已经回答"}); bad || !strings.Contains(string(raw), `"state":"answered"`) || !strings.Contains(string(raw), `"truncated":true`) {
		t.Fatal("已回答内容超出工具容量", string(raw))
	}
}

func TestInboxSystemDatabaseConstraints(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	for _, tc := range []struct {
		condition any
		object    any
		thread    any
	}{
		{nil, h.project.ID, nil},
		{inbox.ProjectNeedsAttention, nil, nil},
		{"task_needs_verification", h.project.ID, nil},
		{inbox.ProjectNeedsAttention, h.project.ID, id},
	} {
		_, err := h.pool.Exec(h.ctx, `INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,source,condition_type,condition_object_id,thread_id,title) VALUES($1,$2,$3,$4,$5,'system',$6,$7,$8,'系统事项')`, mustUUID(t), h.owner, h.project.ID, h.project.Agent.ID, h.project.Conversation.ID, tc.condition, tc.object, tc.thread)
		var rejected *pgconn.PgError
		if !errors.As(err, &rejected) || rejected.Code != "23514" {
			t.Fatal(tc, err)
		}
	}
}

func TestInboxProjectSystemLifecycle(t *testing.T) {
	h := newToolHarness(t)
	for i := 0; i < 3; i++ {
		if i > 0 {
			acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, fmt.Sprintf("system-%d", i), "重试")
			if err := h.repo.ScheduleProjectRuns(h.ctx); err != nil {
				t.Fatal(err)
			}
			h.req = runtimeRequest(t, h.ctx, h.pool, h.project.Agent.ID, "bootstrap")
		}
		if _, err := h.pool.Exec(h.ctx, `UPDATE conversations SET failure_count=2 WHERE id=$1`, h.project.Conversation.ID); err != nil {
			t.Fatal(err)
		}
		req := h.req
		req.Operation = "report_failure"
		req.Reason = "持续模型失败"
		if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil {
			t.Fatal(err)
		}
		page, err := h.repo.Inbox(h.ctx, h.owner, "open", "")
		if err != nil || len(page.Requests) != 1 || page.Requests[0].ConditionType != inbox.ProjectNeedsAttention || page.Requests[0].ThreadID != "" {
			t.Fatal(page, err)
		}
		r := page.Requests[0]
		if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, r.ID, answerInbox("system-answer"), false); !errors.Is(err, inbox.ErrInvalid) {
			t.Fatal(err)
		}
		if _, err = h.pool.Exec(h.ctx, `UPDATE conversations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`, h.project.Conversation.ID); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, r.ID, inbox.Handle{ExpectedVersion: 1, ClientRequestID: "close-system"}, true); err != nil {
				t.Fatal(err)
			}
		}
		for range 2 {
			if err = h.repo.ScheduleProjectRuns(h.ctx); err != nil {
				t.Fatal(err)
			}
		}
		if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests WHERE source='system'`); n != i+1 {
			t.Fatal("状态未变化时重复创建", n)
		}
		if err = h.repo.RetryProject(h.ctx, h.owner, h.project.ID); err != nil {
			t.Fatal(err)
		}
		current, err := h.repo.AttentionRequest(h.ctx, h.owner, r.ID)
		want := "resolved"
		if i == 1 {
			want = "closed"
		}
		if err != nil || current.State != want {
			t.Fatal(current, err)
		}
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='attention_answer'`); n != 0 {
		t.Fatal("系统事项产生输入", n)
	}
}

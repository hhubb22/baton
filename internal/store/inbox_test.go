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
	"baton/internal/task"
)

func inboxArgs() map[string]any {
	return map[string]any{"title": "需要用户决定", "summary": "检查失败", "content": "[证据](https://example.org/result)", "options": []inbox.Option{{ID: "continue", Label: "继续", Recommended: true}, {ID: "stop", Label: "停止"}}, "allow_text": true}
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
	if err = inbox.CreateSystem(h.ctx, tx, b, inbox.ProjectNeedsAttention, h.project.ID, "Project 需要处理", "模型失败", "", nil, nil); err != nil {
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
	_, err = inbox.CreateAgent(h.ctx, tx, inbox.Binding{EmployeeID: h.owner, ProjectID: other.ID, AgentID: other.Agent.ID, ConversationID: other.Conversation.ID}, "other", inbox.Ask{Title: "其他 Project", AllowText: true}, nil, nil)
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
func TestInboxTaskSnapshotAndSystemLifecycle(t *testing.T) {
	h := newToolHarness(t)
	id := h.dispatch(t)
	// 使用真实接受/启动/报告路径；输入许可使用项目工具创建的任务。
	var in store.StartRequest
	var messageID string
	if err := h.pool.QueryRow(h.ctx, `SELECT e.id::text,o.id::text FROM executions e JOIN dispatch_outbox o ON o.execution_id=e.id WHERE e.task_id=$1`, id).Scan(&in.ExecutionID, &messageID); err != nil {
		t.Fatal(err)
	}
	in.EmployeeID = h.owner
	in.NodeID = h.src.NodeID
	in.TaskID = id
	in.SessionID = mustUUID(t)
	in.StorageGeneration = mustUUID(t)
	in.Nonce = mustUUID(t)
	in.CredentialID = h.src.CredentialID
	if err := h.repo.SavePrepared(h.ctx, store.PreparedFact{MessageID: messageID, EmployeeID: h.owner, NodeID: h.src.NodeID, TaskID: id, ExecutionID: in.ExecutionID, SessionID: in.SessionID, StorageGeneration: in.StorageGeneration}); err != nil {
		t.Fatal(err)
	}
	if decision, err := h.repo.AuthorizeStart(h.ctx, in); err != nil || !decision.Issue {
		t.Fatal(decision, err)
	}
	// 执行报告沿用已保存的启动身份。
	uncertain := store.ExecutionReport{EmployeeID: h.owner, NodeID: h.src.NodeID, TaskID: id, ExecutionID: in.ExecutionID, SessionID: in.SessionID, EventID: mustUUID(t), Kind: task.EventNeedsVerification, Status: task.StatusNeedsVerification, ErrorCode: task.CodeUncertainWorker}
	if _, err := h.pool.Exec(h.ctx, `CREATE FUNCTION reject_attention_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected attention failure'; END $$; CREATE TRIGGER reject_attention_insert BEFORE INSERT ON attention_requests FOR EACH ROW EXECUTE FUNCTION reject_attention_insert()`); err != nil {
		t.Fatal(err)
	}
	if ack, _, err := h.repo.ApplyExecutionReport(h.ctx, uncertain); err == nil || ack {
		t.Fatal("系统事项失败时任务仍提交")
	}
	if current, err := h.repo.GetTask(h.ctx, h.owner, id); err != nil || current.Status != task.StatusQueued {
		t.Fatal("系统事项和状态未一起回滚", err)
	}
	if _, err := h.pool.Exec(h.ctx, `DROP TRIGGER reject_attention_insert ON attention_requests; DROP FUNCTION reject_attention_insert()`); err != nil {
		t.Fatal(err)
	}
	if ack, _, err := h.repo.ApplyExecutionReport(h.ctx, uncertain); err != nil || !ack {
		t.Fatal(err)
	}
	page, err := h.repo.Inbox(h.ctx, h.owner, "open", "")
	if err != nil || len(page.Requests) != 1 {
		t.Fatal(page, err)
	}
	sys := page.Requests[0]
	if sys.Source != "system" || sys.ConditionType != inbox.TaskNeedsVerification || sys.ActionURL != "/tasks/"+id {
		t.Fatal(sys)
	}
	if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, sys.ID, answerInbox("invalid-system"), false); !errors.Is(err, inbox.ErrInvalid) {
		t.Fatal("系统接受回答", err)
	}
	if _, bad := h.call(t, "inbox.withdraw", map[string]any{"request_id": sys.ID, "reason": "模型撤回"}); !bad {
		t.Fatal("模型撤回系统事项")
	}
	if _, err = h.repo.HandleAttentionRequest(h.ctx, h.owner, sys.ID, inbox.Handle{ExpectedVersion: 1, ClientRequestID: "system-close"}, true); err != nil {
		t.Fatal(err)
	}
	uncertain.EventID = mustUUID(t)
	if ack, _, err := h.repo.ApplyExecutionReport(h.ctx, uncertain); err != nil || !ack {
		t.Fatal(err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests`); n != 1 {
		t.Fatal("关闭后重复创建", n)
	}
	args := inboxArgs()
	args["task_id"] = id
	raw, bad := h.call(t, "inbox.ask", args)
	if bad {
		t.Fatal(string(raw))
	}
	var created struct {
		ID string `json:"request_id"`
	}
	_ = json.Unmarshal(raw, &created)
	original, err := h.repo.AttentionRequest(h.ctx, h.owner, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := h.repo.GetTask(h.ctx, h.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := h.repo.ResolveTask(h.ctx, h.owner, id, resolutionInput(rec.Version, task.StatusCompleted))
	if err != nil {
		t.Fatal(err)
	}
	current, err := h.repo.AttentionRequest(h.ctx, h.owner, created.ID)
	if err != nil || *current.TaskResultVersion != *original.TaskResultVersion || *current.LatestTaskResultVersion != resolved.Version || string(current.TaskResult) != string(original.TaskResult) {
		t.Fatal("引用原结果变化", err)
	}
	// 已核实之后构造同一执行再次运行的夹具，再通过真实报告路径进入待核实。
	if _, err = h.pool.Exec(h.ctx, `UPDATE tasks SET status='running',version=version+1 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	uncertain.EventID = mustUUID(t)
	if ack, _, err := h.repo.ApplyExecutionReport(h.ctx, uncertain); err != nil || !ack {
		t.Fatal(err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests WHERE source='system'`); n != 2 {
		t.Fatal("重入未创建新事项", n)
	}
	rec, err = h.repo.GetTask(h.ctx, h.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	h.repo.SetTaskCommitHook(func(context.Context) error { return errors.New("核实回滚") })
	if _, err = h.repo.ResolveTask(h.ctx, h.owner, id, resolutionInput(rec.Version, task.StatusCompleted)); err == nil {
		t.Fatal("核实未回滚")
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests WHERE source='system' AND state='open'`); n != 1 {
		t.Fatal("系统解决未回滚")
	}
	h.repo.SetTaskCommitHook(nil)
	if _, err = h.repo.ResolveTask(h.ctx, h.owner, id, resolutionInput(rec.Version, task.StatusCompleted)); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM attention_requests WHERE source='system' AND state='resolved'`); n != 1 {
		t.Fatal("核实未解决", n)
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='attention_answer'`); n != 0 {
		t.Fatal("系统生成输入", n)
	}
	t.Log("待核实创建、关闭不重建、条件重入新事项、核实解决同事务；人工修正保留原引用并返回最新版本")
}

func TestInboxContentPagingTaskOwnershipAndEscapedReply(t *testing.T) {
	h := newToolHarness(t)
	id := h.dispatch(t)
	other, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "其他 Project"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE tasks SET project_id=$2,origin_conversation_id=$3 WHERE id=$1`, id, other.ID, other.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	args := inboxArgs()
	args["task_id"] = id
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

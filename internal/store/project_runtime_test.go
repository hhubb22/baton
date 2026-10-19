package store_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func projectRunNode(t *testing.T, ctx context.Context, pool *pgxpool.Pool, repo *store.Store, owner, name string, available bool) protocol.Source {
	t.Helper()
	n := mustRegister(t, ctx, pool, repo, owner, name, node.RolePC, []string{"codex"})
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: owner, NodeID: n.NodeID, CredentialID: n.Credential.ID, ConnID: mustID(t), Incarnation: mustID(t)}
	if err := repo.ConnectNode(ctx, src); err != nil {
		t.Fatal(err)
	}
	if err := repo.SyncNode(ctx, owner, n.NodeID, src.ConnID, name, node.SystemLinux, "", []string{"codex"}); err != nil {
		t.Fatal(err)
	}
	status := "login_required"
	if available {
		status = "available"
	}
	if _, err := repo.SaveRuntimeReport(ctx, src, protocol.RuntimeReport{ProjectRuntime: &protocol.ProjectRuntime{Version: "test", Providers: []protocol.RuntimeProvider{{Provider: "openai-codex", Status: status}}}, Exec: protocol.RuntimeExec{Shell: "sh"}}); err != nil {
		t.Fatal(err)
	}
	return src
}

func projectRunFixture(t *testing.T) (context.Context, *pgxpool.Pool, *store.Store, string, projectagent.Project, protocol.Source) {
	ctx, pool, repo, owner, p := projectFixture(t)
	provider, model := "openai-codex", "test"
	var err error
	p, err = repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Provider: &provider, Model: &model})
	if err != nil {
		t.Fatal(err)
	}
	src := projectRunNode(t, ctx, pool, repo, owner, "Runtime", true)
	return ctx, pool, repo, owner, p, src
}

func runtimeRequest(t *testing.T, ctx context.Context, pool *pgxpool.Pool, agentID, operation string) protocol.ProjectRuntimeRequest {
	t.Helper()
	var r protocol.ProjectRuntimeRequest
	r.Type = protocol.BodyProjectRuntimeRequest
	r.Operation = operation
	if err := pool.QueryRow(ctx, `SELECT lease_run_id::text,lease_epoch FROM project_agents WHERE id=$1`, agentID).Scan(&r.RunID, &r.LeaseEpoch); err != nil {
		t.Fatal(err)
	}
	return r
}
func acceptProjectInput(t *testing.T, ctx context.Context, repo *store.Store, owner, projectID, key, body string) {
	t.Helper()
	if _, err := repo.AcceptProjectMessage(ctx, owner, projectID, projectagent.MessageInput{ClientMessageID: key, Content: body}); err != nil {
		t.Fatal(err)
	}
}

func TestProjectRunConcurrentSchedulingAndLeaseFence(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "message", "主动输入")
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- repo.ScheduleProjectRuns(ctx) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_runs`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("并发运行数 %d %v", count, err)
	}
	old := runtimeRequest(t, ctx, pool, p.Agent.ID, "bootstrap")
	if _, err := pool.Exec(ctx, `UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, p.Agent.ID); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"bootstrap", "read_events", "claim_inputs", "append_event", "append_compaction", "preview", "renew", "started", "report_failure", "finish", "start_failed", "exited"} {
		old.Operation = op
		if _, err := repo.ProjectRuntime(ctx, src, old); !errors.Is(err, projectagent.ErrLeaseLost) {
			t.Fatalf("过期 %s: %v", op, err)
		}
	}
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	current := runtimeRequest(t, ctx, pool, p.Agent.ID, "bootstrap")
	if current.LeaseEpoch != old.LeaseEpoch+1 || current.RunID == old.RunID {
		t.Fatal("新运行没有增加代次")
	}
	old.Operation = "renew"
	if _, err := repo.ProjectRuntime(ctx, src, old); !errors.Is(err, projectagent.ErrLeaseLost) {
		t.Fatal("旧运行恢复写入")
	}
	if _, err := repo.ProjectRuntime(ctx, src, current); err != nil {
		t.Fatal(err)
	}
}

func TestProjectRunPassiveCoalescingAndFallback(t *testing.T) {
	ctx, pool, repo, owner, p, defaultSrc := projectRunFixture(t)
	report := protocol.RuntimeReport{ProjectRuntime: &protocol.ProjectRuntime{Version: "test", Providers: []protocol.RuntimeProvider{{Provider: "openai-codex", Status: "login_required"}}}, Exec: protocol.RuntimeExec{Shell: "sh"}}
	if _, err := repo.SaveRuntimeReport(ctx, defaultSrc, report); err != nil {
		t.Fatal(err)
	}
	fallback := projectRunNode(t, ctx, pool, repo, owner, "备用", true)
	entry, _ := identity.NewUUID()
	for i := int64(0); i < 3; i++ {
		if _, err := repo.WriteProjectMemory(ctx, owner, p.ID, entry, projectagent.MemoryWrite{Title: "用户记忆", Content: fmt.Sprint(i), ExpectedRevision: i, Author: "user"}); err != nil {
			t.Fatal(err)
		}
	}
	goal := strings.Repeat("<标题目标>", 2000)
	if _, err := repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Goal: &goal}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_runs`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("被动输入启动了运行: %d %v", count, err)
	}
	// 既有API接受64KiB HTML字符，真实领取仍必须能装入事件与控制帧。
	acceptProjectInput(t, ctx, repo, owner, p.ID, "message", strings.Repeat("<", 64<<10))
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	var placed, reason, savedDefault string
	if err := pool.QueryRow(ctx, `SELECT node_id::text,placement_reason FROM agent_runs`).Scan(&placed, &reason); err != nil {
		t.Fatal(err)
	}
	if placed != fallback.NodeID || reason != "default_login_required" {
		t.Fatalf("放置 %s %s", placed, reason)
	}
	if err := pool.QueryRow(ctx, `SELECT default_device_node_id::text FROM employee_settings WHERE employee_id=$1`, owner).Scan(&savedDefault); err != nil || savedDefault != defaultSrc.NodeID {
		t.Fatal("改写默认设备")
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
	data, err := repo.ProjectRuntime(ctx, fallback, req)
	if err != nil {
		t.Fatal(err)
	}
	claim := data.(projectagent.Claim)
	var payload struct {
		InputIDs []int64 `json:"input_ids"`
		Message  struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err = json.Unmarshal(claim.Event.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	var inputs []projectagent.QueuedInput
	if err = json.Unmarshal([]byte(payload.Message.Content[0].Text), &inputs); err != nil {
		t.Fatal(err)
	}
	memories := 0
	for _, input := range inputs {
		if input.SourceType == "memory_updated" {
			memories++
			var m struct {
				Revision int64 `json:"revision"`
			}
			_ = json.Unmarshal(input.Payload, &m)
			if m.Revision != 3 {
				t.Fatal("未送最新记忆")
			}
		}
	}
	if memories != 1 || len(inputs) != 3 {
		t.Fatalf("输入数量或记忆合并: %+v", inputs)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE delivered_seq IS NULL`).Scan(&count); err != nil || count != 0 {
		t.Fatal("旧记忆通知未一起投递")
	}
	raw, _ := protocol.MarshalJSON(claim)
	if len(raw) > protocol.MaxProjectRuntimeBytes {
		t.Fatal("领取响应超限")
	}
	if _, err := repo.WriteProjectMemory(ctx, owner, p.ID, entry, projectagent.MemoryWrite{Title: "Agent记忆", Content: "模型更新", ExpectedRevision: 3, Author: "agent"}); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE delivered_seq IS NULL`).Scan(&count); err != nil || count != 0 {
		t.Fatal("Agent写记忆产生被动通知")
	}
}

func TestProjectRunBoundedResultsAndAssistantIdempotency(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	for i := 1; i <= 20; i++ {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err = store.EnqueueProjectTaskResult(ctx, tx, owner, p.Agent.ID, store.ProjectTaskResultInput{TaskID: mustID(t), Version: 1, Status: "completed", Text: strings.Repeat("a", 16<<10) + strings.Repeat("b", 16<<10)}); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
	received, rounds := 0, 0
	var last int64
	for received < 20 {
		req.LastSeq = last
		data, err := repo.ProjectRuntime(ctx, src, req)
		if err != nil {
			t.Fatal(err)
		}
		claim := data.(projectagent.Claim)
		if claim.Event == nil || claim.PayloadBytes > 128<<10 || claim.InputCount > 20 || len(claim.Event.Payload) > 160<<10 {
			t.Fatalf("批次超限 %+v", claim)
		}
		received += claim.InputCount
		rounds++
		last = claim.Event.Seq
	}
	if rounds < 5 {
		t.Fatalf("结果批次数 %d", rounds)
	}
	req.Operation = "append_event"
	req.LastSeq = last
	req.ClientEventID = "assistant-idempotent"
	req.Payload = []byte(`{"format":"pi-ai/1","message":{"role":"assistant","content":[{"type":"text","text":"完成"}],"thinking_signature":"opaque"}}`)
	data, err := repo.ProjectRuntime(ctx, src, req)
	if err != nil {
		t.Fatal(err)
	}
	e := data.(projectagent.Event)
	data, err = repo.ProjectRuntime(ctx, src, req)
	if err != nil || data.(projectagent.Event).Seq != e.Seq {
		t.Fatal("重发assistant不幂等")
	}
	req.ClientEventID = "next-assistant"
	if _, err = repo.ProjectRuntime(ctx, src, req); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatalf("过期seq写入: %v", err)
	}
	req.LastSeq = e.Seq
	req.Payload = []byte(`{"format":"pi-ai/1","message":{"role":"assistant","content":[{"type":"text","text":"` + strings.Repeat("x", 161<<10) + `"}]}}`)
	if _, err = repo.ProjectRuntime(ctx, src, req); !errors.Is(err, projectagent.ErrTooLarge) {
		t.Fatalf("超长输出: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	original := strings.Repeat("开始中文", 6000) + strings.Repeat("<\"\\", 6000) + strings.Repeat("末尾中文", 6000)
	taskID := mustID(t)
	if err = store.EnqueueProjectTaskResult(ctx, tx, owner, p.Agent.ID, store.ProjectTaskResultInput{TaskID: taskID, Version: 1, Status: "completed", Text: original}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var result store.ProjectTaskResultInput
	var payload []byte
	var size int
	if err = pool.QueryRow(ctx, `SELECT payload,octet_length(payload::text) FROM project_agent_input_queue WHERE source_key=$1`, "task:"+taskID+":result:1").Scan(&payload, &size); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(payload, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Text) > 32<<10 || size > 40<<10 || !result.Truncated || result.OriginalBytes != len(original) || !strings.HasPrefix(result.Text, "开始") || !strings.HasSuffix(result.Text, "中文") {
		t.Fatalf("结果限长 %d %d", len(result.Text), size)
	}
}

func TestProjectRunFailureBackoffAndRecoveryWithoutQueuedInput(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "message", "同一输入继续")
	var inputSeq int64
	for i, minutes := range []int{1, 5, 15} {
		if err := repo.ScheduleProjectRuns(ctx); err != nil {
			t.Fatal(err)
		}
		req := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
		if i == 0 {
			data, err := repo.ProjectRuntime(ctx, src, req)
			if err != nil {
				t.Fatal(err)
			}
			inputSeq = data.(projectagent.Claim).Event.Seq
		}
		req.Operation = "report_failure"
		req.Reason = "provider持续失败"
		if _, err := repo.ProjectRuntime(ctx, src, req); err != nil {
			t.Fatal(err)
		}
		var failure int
		var state string
		var next time.Time
		if err := pool.QueryRow(ctx, `SELECT failure_count,state,next_attempt_at FROM conversations WHERE id=$1`, p.Conversation.ID).Scan(&failure, &state, &next); err != nil {
			t.Fatal(err)
		}
		delay := time.Until(next)
		if failure != i+1 || delay < time.Duration(minutes)*time.Minute-5*time.Second || delay > time.Duration(minutes)*time.Minute+time.Second {
			t.Fatalf("失败推迟: %d %s %s", failure, state, delay)
		}
		if i == 2 && state != "needs_attention" {
			t.Fatal("第三次未暂停")
		}
		if _, err := pool.Exec(ctx, `UPDATE conversations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`, p.Conversation.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_runs`).Scan(&count); err != nil || count != 3 {
		t.Fatal("needs_attention继续调度")
	}
	if err := repo.RetryProject(ctx, owner, p.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "bootstrap")
	data, err := repo.ProjectRuntime(ctx, src, req)
	if err != nil {
		t.Fatal(err)
	}
	if data.(projectagent.Bootstrap).LastSeq != inputSeq {
		t.Fatal("重试没有从原输入位置恢复")
	}
}

func TestProjectRunBootstrapPagesLargeCompactionAndConfiguration(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	goal := strings.Repeat("g", 64<<10)
	if _, err := repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Goal: &goal}); err != nil {
		t.Fatal(err)
	}
	payload, _ := protocol.MarshalJSON(map[string]any{"through_seq": 0, "summary": strings.Repeat("s", 150<<10)})
	if _, err := pool.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES($1,1,$2,'compaction',$3)`, p.Conversation.ID, owner, payload); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE conversations SET next_seq=2,compaction_seq=1 WHERE id=$1`, p.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	acceptProjectInput(t, ctx, repo, owner, p.ID, "resume", "继续")
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "bootstrap")
	data, err := repo.ProjectRuntime(ctx, src, req)
	if err != nil {
		t.Fatal(err)
	}
	boot := data.(projectagent.Bootstrap)
	raw, _ := protocol.MarshalJSON(boot)
	if boot.Compaction != nil || boot.CompactionSeq != 1 || boot.Project.Goal != goal || len(raw) > protocol.MaxProjectRuntimeBytes {
		t.Fatal("bootstrap未分离超长摘要或丢失配置")
	}
	req.Operation = "read_events"
	req.AfterSeq = boot.AfterSeq
	data, err = repo.ProjectRuntime(ctx, src, req)
	if err != nil {
		t.Fatal(err)
	}
	page := data.(projectagent.EventPage)
	if len(page.Events) != 1 || page.Events[0].Seq != boot.CompactionSeq || page.Events[0].Kind != "compaction" {
		t.Fatal("分页未返回原摘要")
	}
	raw, _ = protocol.MarshalJSON(page)
	if len(raw) > protocol.MaxProjectRuntimeBytes {
		t.Fatal("单事件分页响应超限")
	}
}

func TestProjectRunBootstrapPreservesControlCharactersInGoal(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	goal := strings.Repeat("\x01", 64<<10)
	if _, err := repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Goal: &goal}); err != nil {
		t.Fatal(err)
	}
	acceptProjectInput(t, ctx, repo, owner, p.ID, "start-control-goal", "继续")
	if err := repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "bootstrap")
	data, err := repo.ProjectRuntime(ctx, src, req)
	if err != nil {
		t.Fatal(err)
	}
	boot := data.(projectagent.Bootstrap)
	decoded, err := base64.StdEncoding.DecodeString(boot.GoalUTF8Base64)
	if err != nil || string(decoded) != goal {
		t.Fatal("bootstrap改变合法目标")
	}
	raw, _ := protocol.MarshalJSON(boot)
	if len(raw) > protocol.MaxProjectRuntimeBytes {
		t.Fatal("bootstrap目标编码超出单帧")
	}
}

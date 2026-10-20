package store_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"baton/internal/projectagent"
	"baton/internal/protocol"
)

func compactionRequest(t *testing.T, h *toolHarness, through int64) protocol.ProjectRuntimeRequest {
	t.Helper()
	req := h.req
	req.Operation, req.LastSeq, req.ClientEventID = "commit_compaction", h.seq, fmt.Sprintf("compact-%d", h.seq)
	p := projectagent.Compaction{
		ThroughSeq: through, Summary: "已查询设备。", ClearedToolResultSeqs: []int64{},
		Prompt:       projectagent.PromptSnapshot{Version: "1", Title: h.project.Title, Goal: h.project.Goal},
		TokensBefore: 1000, TokensAfter: 200, Provider: "openai-codex", Model: "test",
	}
	if through == 0 {
		p.Summary = ""
	}
	req.Payload, _ = json.Marshal(p)
	return req
}
func nextCompactionInput(t *testing.T, h *toolHarness, key string) {
	t.Helper()
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, key, "继续处理任务，保留用户的约束和待办")
	req := h.req
	req.Operation, req.LastSeq = "claim_inputs", h.seq
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Claim).Event.Seq
}

func TestProjectRunCompactionFencesHistoryAndConcurrentCommits(t *testing.T) {
	h := newToolHarness(t)
	h.call(t, "devices.list", map[string]any{})
	nextCompactionInput(t, h, "next")
	req := compactionRequest(t, h, 3)
	stale := req
	stale.LastSeq--
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, stale); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatalf("旧快照: %v", err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			request := req
			request.ClientEventID = fmt.Sprintf("concurrent-%d", i)
			_, err := h.repo.ProjectRuntime(h.ctx, h.src, request)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, projectagent.ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("并发结果: %d/%d", success, conflict)
	}
}

func TestProjectRunCompactionKeepsPendingRecoveryWork(t *testing.T) {
	h := newToolHarness(t)
	h.call(t, "devices.list", map[string]any{})
	h.call(t, "devices.list", map[string]any{})
	req := compactionRequest(t, h, 3)
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil {
		t.Fatal(err)
	}
	// 轮内压缩之后进程退出；最后一个工具结果仍然需要模型继续分析。
	req.Operation = "exited"
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil {
		t.Fatal(err)
	}
	if err := h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	next := runtimeRequest(t, h.ctx, h.pool, h.project.Agent.ID, "bootstrap")
	if next.RunID == req.RunID || next.LeaseEpoch != req.LeaseEpoch+1 {
		t.Fatal("压缩事件遮蔽了未完成的工具轮次")
	}
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, next)
	if err != nil {
		t.Fatal(err)
	}
	boot := out.(projectagent.Bootstrap)
	if boot.AfterSeq != 3 || boot.Compaction == nil {
		t.Fatalf("恢复起点: %+v", boot)
	}
}

func TestProjectRunCompactionInsertAndPointerUpdateAreAtomic(t *testing.T) {
	h := newToolHarness(t)
	h.call(t, "devices.list", map[string]any{})
	nextCompactionInput(t, h, "next")
	if _, err := h.pool.Exec(h.ctx, `CREATE FUNCTION reject_compaction_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'injected pointer failure'; END $$;
 CREATE TRIGGER reject_compaction_pointer BEFORE UPDATE ON conversations FOR EACH ROW
 WHEN (NEW.compaction_seq IS DISTINCT FROM OLD.compaction_seq) EXECUTE FUNCTION reject_compaction_pointer()`); err != nil {
		t.Fatal(err)
	}
	req := compactionRequest(t, h, 3)
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err == nil {
		t.Fatal("未注入失败")
	}
	var count int
	var seq int64
	var compact *int64
	if err := h.pool.QueryRow(h.ctx, `SELECT next_seq,compaction_seq,(SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='compaction') FROM conversations WHERE id=$1`, h.project.Conversation.ID).Scan(&seq, &compact, &count); err != nil {
		t.Fatal(err)
	}
	if count != 0 || compact != nil || seq != h.seq+1 {
		t.Fatalf("事务未回滚: %d %v %d", count, compact, seq)
	}
}

func TestProjectRunCompactionClearSetIsMonotonicAndProtectsRecentResults(t *testing.T) {
	h := newToolHarness(t)
	h.call(t, "devices.list", map[string]any{})
	makeRequest := func() protocol.ProjectRuntimeRequest {
		req := compactionRequest(t, h, 0)
		var p projectagent.Compaction
		_ = json.Unmarshal(req.Payload, &p)
		p.ClearedToolResultSeqs = []int64{3}
		req.Payload, _ = json.Marshal(p)
		return req
	}
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, makeRequest()); !errors.Is(err, projectagent.ErrInvalid) {
		t.Fatalf("未分析的结果被清除: %v", err)
	}
	for i := range 3 {
		nextCompactionInput(t, h, fmt.Sprintf("input-%d", i))
	}
	// 最新 assistant 已分析过该工具结果。
	req := h.req
	req.Operation, req.LastSeq, req.ClientEventID = "append_event", h.seq, "analysis"
	req.Payload = json.RawMessage(`{"format":"pi-ai/1","message":{"role":"assistant","content":[{"type":"text","text":"已分析设备列表"}]}}`)
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Event).Seq
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, makeRequest())
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Event).Seq
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, compactionRequest(t, h, 0)); !errors.Is(err, projectagent.ErrInvalid) {
		t.Fatalf("已清除集合丢失: %v", err)
	}
}

func TestProjectRunCompactionValidationAndPayloadLimit(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*projectagent.Compaction)
		want   error
	}{
		{"虚假token缩减", func(p *projectagent.Compaction) { p.TokensAfter = p.TokensBefore }, projectagent.ErrInvalid},
		{"未知提示词版本", func(p *projectagent.Compaction) { p.Prompt.Version = "99" }, projectagent.ErrInvalid},
		{"错误模型", func(p *projectagent.Compaction) { p.Model = "another" }, projectagent.ErrInvalid},
		{"错误provider", func(p *projectagent.Compaction) { p.Provider = "another" }, projectagent.ErrInvalid},
		{"记忆索引超限", func(p *projectagent.Compaction) { p.MemoryIndex = strings.Repeat("中", 700) }, projectagent.ErrInvalid},
		{"序号不是工具结果", func(p *projectagent.Compaction) { p.ClearedToolResultSeqs = []int64{4} }, projectagent.ErrInvalid},
		{"重复清除序号", func(p *projectagent.Compaction) { p.ClearedToolResultSeqs = []int64{3, 3} }, projectagent.ErrInvalid},
		{"摘要NUL", func(p *projectagent.Compaction) { p.Summary = "a\x00b" }, projectagent.ErrInvalid},
		{"JSON转义容量", func(p *projectagent.Compaction) { p.Summary = strings.Repeat("\x01", 30000) }, projectagent.ErrTooLarge},
		{"过时配置快照", func(p *projectagent.Compaction) { p.Prompt.Title = "旧标题" }, projectagent.ErrConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newToolHarness(t)
			h.call(t, "devices.list", map[string]any{})
			nextCompactionInput(t, h, "next")
			req := compactionRequest(t, h, 3)
			var p projectagent.Compaction
			_ = json.Unmarshal(req.Payload, &p)
			test.change(&p)
			req.Payload, _ = json.Marshal(p)
			if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, test.want) {
				t.Fatalf("期望 %v，得到 %v", test.want, err)
			}
		})
	}
}

func TestProjectRunBootstrapMemoryIndexIsBoundedAndContainsNoBodies(t *testing.T) {
	h := newToolHarness(t)
	for i := range 12 {
		_, err := h.repo.WriteProjectMemory(h.ctx, h.owner, h.project.ID, mustID(t), projectagent.MemoryWrite{
			Title: fmt.Sprintf("%02d-%s", i, strings.Repeat("标题", 90)), Content: "不能进入索引的记忆正文", Author: "user",
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	req := h.req
	req.Operation = "bootstrap"
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	index := out.(projectagent.Bootstrap).MemoryIndex
	if index == "" || len(index) > 2<<10 || !utf8.ValidString(index) || strings.Contains(index, "记忆正文") {
		t.Fatalf("无效记忆索引 %d", len(index))
	}
}

package store_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"baton/internal/projectagent"
)

func TestProjectRunCommitCompaction(t *testing.T) {
	h := newToolHarness(t)
	h.call(t, "devices.list", map[string]any{})
	// 留下一个完整的后续输入，摘要不能吞掉对话结尾。
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "next", "继续")
	req := h.req
	req.Operation, req.LastSeq = "claim_inputs", h.seq
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Claim).Event.Seq
	payload := map[string]any{
		"through_seq": int64(3), "summary": "已查询设备。", "cleared_tool_result_seqs": []int64{}, "memory_index": "",
		"prompt":        map[string]string{"version": "1", "title": h.project.Title, "goal": h.project.Goal},
		"tokens_before": 1000, "tokens_after": 200,
		"provider": "openai-codex", "model": "test",
	}
	req.Operation, req.LastSeq, req.ClientEventID = "commit_compaction", h.seq, "compact-1"
	req.Payload, _ = json.Marshal(payload)
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	e := out.(projectagent.Event)
	if e.Kind != "compaction" || e.Seq != h.seq+1 {
		t.Fatalf("压缩事件: %+v", e)
	}
	// 丢失回执后的同 ID 重发返回原事件，不受旧 last_seq 影响。
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || out.(projectagent.Event).Seq != e.Seq {
		t.Fatalf("重发: %v %v", out, err)
	}
	payload["summary"] = "不同摘要"
	req.Payload, _ = json.Marshal(payload)
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatalf("标识复用: %v", err)
	}
	req.Operation, req.Payload = "bootstrap", nil
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	boot := out.(projectagent.Bootstrap)
	if boot.CompactionSeq != e.Seq || boot.AfterSeq != 3 {
		t.Fatalf("恢复: %+v", boot)
	}
	var count int
	if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND seq<=3`, h.project.Conversation.ID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("原文丢失: %d %v", count, err)
	}
	h.seq = e.Seq
	raw, bad := h.call(t, "history.read", map[string]any{"after_seq": 0, "through_seq": 3})
	if bad {
		t.Fatal(string(raw))
	}
	text, next := readToolPage(t, raw)
	var history struct {
		Events []projectagent.Event `json:"events"`
	}
	if json.Unmarshal([]byte(text), &history) != nil || next != 0 || len(history.Events) != 3 || history.Events[0].Kind != "input" || history.Events[2].Kind != "tool_result" {
		t.Fatal("history.read 未返回压缩范围的原文")
	}
}

func TestProjectRunRejectsInvalidCompaction(t *testing.T) {
	for _, test := range []struct {
		name    string
		through int64
		summary string
	}{
		{"拆开工具调用", 2, "摘要"},
		{"吞掉结尾", 3, "摘要"},
		{"空摘要", 1, " "},
		{"摘要未缩短", 1, strings.Repeat("摘要", 10000)},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := newToolHarness(t)
			h.call(t, "devices.list", map[string]any{})
			req := h.req
			req.Operation, req.LastSeq, req.ClientEventID = "commit_compaction", h.seq, "invalid-compact"
			req.Payload, _ = json.Marshal(map[string]any{
				"through_seq": test.through, "summary": test.summary, "cleared_tool_result_seqs": []int64{},
				"prompt":        map[string]string{"version": "1", "title": h.project.Title, "goal": h.project.Goal},
				"tokens_before": 1000, "tokens_after": 100,
				"provider": "openai-codex", "model": "test",
			})
			if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, projectagent.ErrInvalid) {
				t.Fatalf("无效压缩: %v", err)
			}
		})
	}
}

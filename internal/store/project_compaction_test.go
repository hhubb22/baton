package store_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"baton/internal/projectagent"
)

func compactionHistory(t *testing.T) *toolHarness {
	t.Helper()
	h := newToolHarness(t)
	for i := 0; i < 6; i++ {
		h.call(t, "devices.list", map[string]any{})
		acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, fmt.Sprintf("round-%d", i), "历史目标与决定")
		req := h.req
		req.Operation = "claim_inputs"
		req.LastSeq = h.seq
		raw, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
		if err != nil {
			t.Fatal(err)
		}
		h.seq = raw.(projectagent.Claim).Event.Seq
	}
	return h
}
func TestProjectCompactionValidationAndRawHistory(t *testing.T) {
	h := compactionHistory(t)
	req := h.req
	req.Operation = "append_compaction"
	req.ClientEventID = "compact-1"
	req.LastSeq = h.seq
	original := map[string]any{"through_seq": 3, "summary": "历史目标与决定摘要", "cleared_tool_result_seqs": []int64{6}}
	req.Payload, _ = json.Marshal(original)
	raw, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	saved := raw.(projectagent.Event)
	h.seq = saved.Seq
	var payload struct {
		Through int64             `json:"through_seq"`
		Index   string            `json:"memory_index"`
		Prompt  map[string]string `json:"prompt"`
	}
	if err = json.Unmarshal(saved.Payload, &payload); err != nil || payload.Through != 3 || payload.Prompt["title"] != h.project.Title {
		t.Fatalf("压缩快照 %s %v", saved.Payload, err)
	}
	repeated, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || repeated.(projectagent.Event).Seq != saved.Seq {
		t.Fatalf("响应丢失重试 %v", err)
	}
	// 重试不能用同一个事件标识替换摘要。
	changed := req
	changed.Payload = []byte(`{"through_seq":3,"summary":"另一份摘要","cleared_tool_result_seqs":[6]}`)
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, changed); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatalf("重用事件标识 %v", err)
	}
	for _, body := range []string{
		`{"through_seq":2,"summary":"切开工具调用","cleared_tool_result_seqs":[6]}`,
		`{"through_seq":1,"summary":"范围回退","cleared_tool_result_seqs":[6]}`,
		`{"through_seq":3,"summary":"历史目标与决定摘要","cleared_tool_result_seqs":[]}`,
		`{"through_seq":3,"summary":"历史目标与决定摘要","cleared_tool_result_seqs":[6,17]}`,
		`{"through_seq":3,"summary":"历史目标与决定摘要","cleared_tool_result_seqs":[6,6]}`,
		`{"through_seq":3,"summary":"历史目标与决定摘要","cleared_tool_result_seqs":[6,999]}`,
		`{"through_seq":999,"summary":"未来范围","cleared_tool_result_seqs":[]}`,
	} {
		bad := req
		bad.ClientEventID = "bad"
		bad.LastSeq = h.seq
		bad.Payload = []byte(body)
		if _, err = h.repo.ProjectRuntime(h.ctx, h.src, bad); !errors.Is(err, projectagent.ErrInvalid) {
			t.Fatalf("无效压缩被接受 %s %v", body, err)
		}
	}
	bootReq := h.req
	bootReq.Operation = "bootstrap"
	boot, err := h.repo.ProjectRuntime(h.ctx, h.src, bootReq)
	if err != nil {
		t.Fatal(err)
	}
	if boot.(projectagent.Bootstrap).AfterSeq != 3 || boot.(projectagent.Bootstrap).Compaction.Seq != saved.Seq {
		t.Fatal("bootstrap 未返回最新压缩")
	}
	for _, seq := range []int64{3, 6} {
		text, bad := h.call(t, "history.read", map[string]any{"after_seq": seq - 1, "through_seq": seq})
		if bad || !strings.Contains(string(text), `tool_result`) || strings.Contains(string(text), "已清除") {
			t.Fatalf("原文读取失败 %s", text)
		}
	}
	text, bad := h.call(t, "history.search", map[string]any{"query": "devices.list", "through_seq": 6})
	decoded, _ := readToolPage(t, text)
	if bad || !strings.Contains(decoded, `"seq":3`) || !strings.Contains(decoded, `"seq":6`) {
		t.Fatalf("原文搜索失败 %s", text)
	}
}

func TestProjectCompactionIndexAndClearOnly(t *testing.T) {
	h := compactionHistory(t)
	// 中心在保存压缩事件时读取当前记忆标题。
	h.call(t, "memory.write", map[string]any{"title": "项目记忆", "content": "已决定", "expected_revision": 0})
	req := h.req
	req.Operation = "append_compaction"
	req.ClientEventID = "clear-only"
	req.LastSeq = h.seq
	req.Payload = []byte(`{"through_seq":0,"summary":"","cleared_tool_result_seqs":[3]}`)
	raw, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw.(projectagent.Event).Payload), "项目记忆") {
		t.Fatal("记忆标题未保存")
	}
	var count int
	if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND seq=3 AND kind='tool_result'`, h.project.Conversation.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("清除修改了原文", err)
	}
}

func TestProjectCompactionEveryToolResultRecoverable(t *testing.T) {
	h := newToolHarness(t)
	taskID := h.dispatch(t)
	entryID := mustID(t)
	h.call(t, "memory.write", map[string]any{"entry_id": entryID, "title": "决定", "content": "完整原文", "expected_revision": 0})
	request := askInbox(t, h)
	for _, call := range []struct {
		name string
		args map[string]any
	}{
		{"memory.search", map[string]any{"query": "决定"}},
		{"memory.read", map[string]any{"entry_id": entryID}},
		{"history.search", map[string]any{"query": "决定"}},
		{"history.read", map[string]any{"after_seq": 0, "through_seq": 1}},
		{"devices.list", map[string]any{}},
		{"tasks.list", map[string]any{}},
		{"tasks.get", map[string]any{"task_id": taskID}},
		{"tasks.cancel", map[string]any{"task_id": taskID}},
		{"inbox.list", map[string]any{}},
		{"inbox.get", map[string]any{"request_id": request.ID}},
		{"inbox.withdraw", map[string]any{"request_id": request.ID, "reason": "情况变化"}},
	} {
		if raw, bad := h.call(t, call.name, call.args); bad {
			t.Fatalf("%s: %s", call.name, raw)
		}
	}
	rows, err := h.pool.Query(h.ctx, `SELECT seq,payload FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result' ORDER BY seq`, h.project.Conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	originals := map[int64]json.RawMessage{}
	seqs := []int64{}
	for rows.Next() {
		var seq int64
		var payload json.RawMessage
		if err = rows.Scan(&seq, &payload); err != nil {
			t.Fatal(err)
		}
		originals[seq] = payload
		seqs = append(seqs, seq)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	if len(originals) != 14 {
		t.Fatalf("工具种类 %d", len(originals))
	}
	for i := 0; i < 3; i++ {
		acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, fmt.Sprintf("retain-%d", i), "保留轮次")
		req := h.req
		req.Operation = "claim_inputs"
		req.LastSeq = h.seq
		raw, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
		if err != nil {
			t.Fatal(err)
		}
		h.seq = raw.(projectagent.Claim).Event.Seq
	}
	req := h.req
	req.Operation = "append_compaction"
	req.LastSeq = h.seq
	req.ClientEventID = "all-tool-kinds"
	req.Payload, _ = json.Marshal(map[string]any{"through_seq": 0, "summary": "", "cleared_tool_result_seqs": seqs})
	raw, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = raw.(projectagent.Event).Seq
	for seq, original := range originals {
		var combined strings.Builder
		offset := 0
		for {
			raw, bad := h.call(t, "history.read", map[string]any{"after_seq": seq - 1, "through_seq": seq, "offset": offset})
			if bad {
				t.Fatal(string(raw))
			}
			text, next := readToolPage(t, raw)
			combined.WriteString(text)
			if next == 0 {
				break
			}
			offset = next
		}
		var page struct {
			Events []projectagent.Event `json:"events"`
		}
		if err = json.Unmarshal([]byte(combined.String()), &page); err != nil || len(page.Events) != 1 {
			t.Fatal("历史分页", err)
		}
		var equal bool
		if err = h.pool.QueryRow(h.ctx, `SELECT $1::jsonb=$2::jsonb`, original, page.Events[0].Payload).Scan(&equal); err != nil || !equal {
			t.Fatalf("第 %d 条输出恢复不完整 %v", seq, err)
		}
	}
	t.Log("14 类工具输出全部经 history.read 按原序号完整恢复，副作用未重放")
}

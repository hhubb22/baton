package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type compactionPayload struct {
	ThroughSeq int64   `json:"through_seq"`
	Summary    string  `json:"summary"`
	Cleared    []int64 `json:"cleared_tool_result_seqs"`
}

func appendProjectCompaction(ctx context.Context, tx pgx.Tx, b projectRunBinding, req protocol.ProjectRuntimeRequest) (projectagent.Event, error) {
	var out projectagent.Event
	var p compactionPayload
	if req.ClientEventID == "" || len(req.ClientEventID) > 128 || json.Unmarshal(req.Payload, &p) != nil || p.ThroughSeq < 0 || !utf8.ValidString(p.Summary) || strings.ContainsRune(p.Summary, 0) || len(p.Summary) > 96<<10 || len(p.Cleared) > 20000 || (p.ThroughSeq > 0 && strings.TrimSpace(p.Summary) == "") || (p.ThroughSeq == 0 && p.Summary != "") {
		return out, projectagent.ErrInvalid
	}
	// 客户端标识的重试先返回原事件；新写入才检查尾序号和压缩范围。
	existing, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND client_event_id=$2`, b.conversationID, req.ClientEventID))
	if err == nil {
		var saved compactionPayload
		if existing.Kind != "compaction" || json.Unmarshal(existing.Payload, &saved) != nil {
			return out, projectagent.ErrConflict
		}
		a, _ := json.Marshal(p)
		z, _ := json.Marshal(saved)
		if string(a) != string(z) {
			return out, projectagent.ErrConflict
		}
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if req.LastSeq != b.nextSeq-1 {
		return out, projectagent.ErrConflict
	}
	if p.ThroughSeq >= b.nextSeq {
		return out, projectagent.ErrInvalid
	}
	var previous compactionPayload
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT e.payload FROM conversations c JOIN conversation_events e ON e.conversation_id=c.id AND e.seq=c.compaction_seq WHERE c.id=$1`, b.conversationID).Scan(&raw)
	if err == nil {
		if json.Unmarshal(raw, &previous) != nil {
			return out, projectagent.ErrInvalid
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if p.ThroughSeq < previous.ThroughSeq || (p.ThroughSeq == previous.ThroughSeq && p.Summary != previous.Summary) {
		return out, projectagent.ErrInvalid
	}
	if p.ThroughSeq > previous.ThroughSeq {
		var boundary bool
		// 切点后的第一条原文必须是新一轮输入，已覆盖的调用必须都有结果。
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND seq=$2 AND kind<>'compaction')
  AND COALESCE((SELECT kind='input' FROM conversation_events WHERE conversation_id=$1 AND seq>$2 AND kind<>'compaction' ORDER BY seq LIMIT 1),false)
  AND (SELECT count(*)>=2 FROM conversation_events WHERE conversation_id=$1 AND kind='input' AND seq>$2)
  AND NOT EXISTS(SELECT 1 FROM conversation_events a CROSS JOIN LATERAL jsonb_array_elements(a.payload->'message'->'content') call
   WHERE a.conversation_id=$1 AND a.kind='assistant' AND a.seq<=$2 AND call->>'type'='toolCall'
   AND NOT EXISTS(SELECT 1 FROM conversation_events r WHERE r.conversation_id=$1 AND r.kind='tool_result' AND r.tool_call_id=call->>'id' AND r.seq<=$2))`, b.conversationID, p.ThroughSeq).Scan(&boundary)
		if err != nil {
			return out, err
		}
		if !boundary {
			return out, projectagent.ErrInvalid
		}
	}
	selected := map[int64]bool{}
	for _, seq := range p.Cleared {
		if seq <= p.ThroughSeq || seq >= b.nextSeq || selected[seq] {
			return out, projectagent.ErrInvalid
		}
		selected[seq] = true
		var valid bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events e WHERE e.conversation_id=$1 AND e.seq=$2 AND e.kind='tool_result')
   AND (SELECT count(*)>=3 FROM conversation_events WHERE conversation_id=$1 AND kind='input' AND seq>$2)`, b.conversationID, seq).Scan(&valid)
		if err != nil {
			return out, err
		}
		if !valid {
			return out, projectagent.ErrInvalid
		}
	}
	for _, seq := range previous.Cleared {
		if seq > p.ThroughSeq && !selected[seq] {
			return out, projectagent.ErrInvalid
		}
	}
	if p.ThroughSeq == previous.ThroughSeq && len(p.Cleared) == len(previous.Cleared) {
		return out, projectagent.ErrInvalid
	}
	// 记忆索引和下一段提示词取中心快照，Runtime 不能提交别的 Project 的内容。
	rows, err := tx.Query(ctx, `SELECT title FROM project_memory_entries WHERE employee_id=$1 AND project_id=$2 ORDER BY id`, b.owner, b.projectID)
	if err != nil {
		return out, err
	}
	index := ""
	for rows.Next() {
		var title string
		if err = rows.Scan(&title); err != nil {
			rows.Close()
			return out, err
		}
		if len(index)+len(title)+1 > 2048 {
			break
		}
		index += title + "\n"
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	var title, goal string
	if err = tx.QueryRow(ctx, `SELECT title,goal FROM projects WHERE id=$1`, b.projectID).Scan(&title, &goal); err != nil {
		return out, err
	}
	payload, _ := json.Marshal(struct {
		compactionPayload
		MemoryIndex string `json:"memory_index"`
		Prompt      any    `json:"prompt"`
	}{p, index, map[string]string{"version": b.prompt, "title": title, "goal": goal}})
	var size int
	if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)`, payload).Scan(&size); err != nil {
		return out, err
	}
	wire, _ := protocol.MarshalJSON(json.RawMessage(payload))
	if size > projectagent.MaxEventBytes || len(wire) > projectagent.MaxEventBytes {
		return out, projectagent.ErrTooLarge
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,client_event_id,run_id,lease_epoch,payload) VALUES($1,$2,$3,'compaction',$4,$5,$6,$7)`, b.conversationID, b.nextSeq, b.owner, req.ClientEventID, req.RunID, req.LeaseEpoch, payload); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET next_seq=next_seq+1,compaction_seq=$2 WHERE id=$1`, b.conversationID, b.nextSeq); err != nil {
		return out, err
	}
	return scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq=$2`, b.conversationID, b.nextSeq))
}

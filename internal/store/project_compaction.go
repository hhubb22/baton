package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func projectMemoryIndex(ctx context.Context, tx pgx.Tx, projectID string) (string, error) {
	rows, err := tx.Query(ctx, `SELECT title FROM project_memory_entries WHERE project_id=$1 ORDER BY id LIMIT 129`, projectID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var index string
	count := 0
	for rows.Next() {
		var title string
		if err = rows.Scan(&title); err != nil {
			return "", err
		}
		line := "- " + title + "\n"
		if count == 128 || len(index)+len(line) > (2<<10)-4 {
			return index + "…", nil
		}
		index += line
		count++
	}
	return index, rows.Err()
}

func commitProjectCompaction(ctx context.Context, tx pgx.Tx, b projectRunBinding, req protocol.ProjectRuntimeRequest) (projectagent.Event, error) {
	var empty projectagent.Event
	if req.ClientEventID == "" || len(req.ClientEventID) > 128 || !utf8.ValidString(req.ClientEventID) || strings.ContainsRune(req.ClientEventID, 0) || !utf8.Valid(req.Payload) {
		return empty, projectagent.ErrInvalid
	}
	var p projectagent.Compaction
	d := json.NewDecoder(bytes.NewReader(req.Payload))
	d.DisallowUnknownFields()
	if d.Decode(&p) != nil || d.Decode(new(any)) != io.EOF || strings.ContainsRune(p.Summary+p.MemoryIndex+p.Prompt.Title+p.Prompt.Goal, 0) ||
		p.ThroughSeq < 0 || len(p.MemoryIndex) > 2<<10 || p.Prompt.Version != b.prompt || p.Prompt.Title == "" ||
		p.TokensBefore <= 0 || p.TokensAfter < 0 || p.TokensAfter >= p.TokensBefore || p.Provider != b.provider || p.Model != b.model {
		return empty, projectagent.ErrInvalid
	}
	var canonical []byte
	if err := tx.QueryRow(ctx, `SELECT $1::jsonb::text`, req.Payload).Scan(&canonical); err != nil {
		return empty, projectagent.ErrInvalid
	}
	wire, _ := protocol.MarshalJSON(json.RawMessage(canonical))
	if len(canonical) > projectagent.MaxEventBytes || len(wire) > projectagent.MaxEventBytes {
		return empty, projectagent.ErrTooLarge
	}
	// 已提交的同一请求先返回原事件，允许丢失回执后的旧 last_seq 重发。
	old, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND client_event_id=$2`, b.conversationID, req.ClientEventID))
	if err == nil {
		var equal bool
		if err = tx.QueryRow(ctx, `SELECT $1::jsonb=$2::jsonb`, old.Payload, req.Payload).Scan(&equal); err != nil {
			return empty, err
		}
		if !equal || old.Kind != "compaction" {
			return empty, projectagent.ErrConflict
		}
		return old, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	var previousSeq *int64
	if err = tx.QueryRow(ctx, `SELECT next_seq,compaction_seq FROM conversations WHERE id=$1 FOR UPDATE`, b.conversationID).Scan(&b.nextSeq, &previousSeq); err != nil {
		return empty, err
	}
	if req.LastSeq != b.nextSeq-1 {
		return empty, projectagent.ErrConflict
	}
	var previous projectagent.Compaction
	if previousSeq != nil {
		var raw []byte
		if err = tx.QueryRow(ctx, `SELECT payload FROM conversation_events WHERE conversation_id=$1 AND seq=$2`, b.conversationID, *previousSeq).Scan(&raw); err != nil {
			return empty, err
		}
		if json.Unmarshal(raw, &previous) != nil {
			return empty, projectagent.ErrInvalid
		}
	}
	if p.ThroughSeq < previous.ThroughSeq {
		return empty, projectagent.ErrInvalid
	}
	if p.ThroughSeq == previous.ThroughSeq && p.Summary != previous.Summary {
		return empty, projectagent.ErrInvalid
	}
	if p.ThroughSeq > previous.ThroughSeq && strings.TrimSpace(p.Summary) == "" {
		return empty, projectagent.ErrInvalid
	}
	rows, err := tx.Query(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq>$2 ORDER BY seq`, b.conversationID, previous.ThroughSeq)
	if err != nil {
		return empty, err
	}
	var events []projectagent.Event
	for rows.Next() {
		e, scanErr := scanProjectEvent(rows)
		if scanErr != nil {
			rows.Close()
			return empty, scanErr
		}
		events = append(events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return empty, err
	}
	if err = validateCompactionHistory(p, previous, events); err != nil {
		return empty, err
	}
	if p.ThroughSeq == previous.ThroughSeq {
		prompt := previous.Prompt
		if prompt.Version == "" {
			for _, event := range events {
				var saved struct {
					Prompt projectagent.PromptSnapshot `json:"prompt"`
				}
				if event.Kind == "assistant" && json.Unmarshal(event.Payload, &saved) == nil && saved.Prompt.Version != "" {
					prompt = saved.Prompt
					break
				}
			}
		}
		if prompt.Version == "" {
			prompt.Version = b.prompt
			if err = tx.QueryRow(ctx, `SELECT title,goal FROM projects WHERE id=$1`, b.projectID).Scan(&prompt.Title, &prompt.Goal); err != nil {
				return empty, err
			}
		}
		if p.Prompt != prompt {
			return empty, projectagent.ErrConflict
		}
	}
	if p.ThroughSeq > previous.ThroughSeq {
		// 标题和目标在生成摘要期间变化时，使用新配置重新生成，避免保存过时快照。
		var title, goal string
		if err = tx.QueryRow(ctx, `SELECT title,goal FROM projects WHERE id=$1`, b.projectID).Scan(&title, &goal); err != nil {
			return empty, err
		}
		if p.Prompt.Title != title || p.Prompt.Goal != goal {
			return empty, projectagent.ErrConflict
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,client_event_id,run_id,lease_epoch,payload)
 VALUES($1,$2,$3,'compaction',$4,$5,$6,$7)`, b.conversationID, b.nextSeq, b.owner, req.ClientEventID, req.RunID, req.LeaseEpoch, req.Payload); err != nil {
		return empty, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET next_seq=next_seq+1,compaction_seq=$2 WHERE id=$1`, b.conversationID, b.nextSeq); err != nil {
		return empty, err
	}
	return scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq=$2`, b.conversationID, b.nextSeq))
}

// validateCompactionHistory 检查保留边界、工具配对及清除集合；调用方持有 Agent 和对话锁。
func validateCompactionHistory(p, previous projectagent.Compaction, events []projectagent.Event) error {
	bySeq := make(map[int64]projectagent.Event, len(events))
	pending := map[string]bool{}
	balanced := p.ThroughSeq == previous.ThroughSeq
	var last, lastAssistant int64
	prefixChars := compactionUTF16Len(compactionFrame(previous))
	oldCleared := map[int64]bool{}
	for _, seq := range previous.ClearedToolResultSeqs {
		oldCleared[seq] = true
	}
	for _, e := range events {
		bySeq[e.Seq] = e
		if e.Kind == "compaction" {
			continue
		}
		last = e.Seq
		if e.Kind == "assistant" {
			lastAssistant = e.Seq
		}
		if e.Seq > p.ThroughSeq {
			continue
		}
		var body struct {
			Message struct {
				ToolCallID string          `json:"toolCallId"`
				Content    json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(e.Payload, &body) != nil {
			return projectagent.ErrInvalid
		}
		if e.Kind == "assistant" {
			var blocks []savedToolCall
			if json.Unmarshal(body.Message.Content, &blocks) != nil {
				return projectagent.ErrInvalid
			}
			for _, block := range blocks {
				if block.Type == "toolCall" {
					pending[block.ID] = true
				}
			}
		}
		if e.Kind == "tool_result" {
			if !pending[body.Message.ToolCallID] {
				return projectagent.ErrInvalid
			}
			delete(pending, body.Message.ToolCallID)
		}
		if oldCleared[e.Seq] {
			prefixChars += compactionUTF16Len(projectClearedToolText(e.Seq))
		} else {
			prefixChars += compactionContentChars(body.Message.Content)
		}
		if e.Seq == p.ThroughSeq {
			balanced = len(pending) == 0 && e.Kind != "input"
		}
	}
	if !balanced || p.ThroughSeq >= last {
		return projectagent.ErrInvalid
	}
	cleared := map[int64]bool{}
	var prev int64
	for _, seq := range p.ClearedToolResultSeqs {
		e, ok := bySeq[seq]
		if !ok || seq <= prev || seq <= p.ThroughSeq || e.Kind != "tool_result" || seq >= lastAssistant {
			return projectagent.ErrInvalid
		}
		prev, cleared[seq] = seq, true
		if !oldCleared[seq] {
			age := 0
			for _, later := range events {
				if later.Kind == "input" && later.Seq > seq {
					age++
				}
			}
			var body struct {
				Message struct {
					Content json.RawMessage `json:"content"`
				} `json:"message"`
			}
			if json.Unmarshal(e.Payload, &body) != nil || age < 3 || compactionContentChars(body.Message.Content) <= compactionUTF16Len(projectClearedToolText(seq)) {
				return projectagent.ErrInvalid
			}
		}
	}
	for seq := range oldCleared {
		if seq > p.ThroughSeq && !cleared[seq] {
			return projectagent.ErrInvalid
		}
	}
	if p.ThroughSeq == previous.ThroughSeq {
		if len(cleared) <= len(oldCleared) || p.MemoryIndex != previous.MemoryIndex {
			return projectagent.ErrInvalid
		}
	} else if compactionUTF16Len(compactionFrame(p)) >= prefixChars {
		return projectagent.ErrInvalid
	}
	return nil
}

// 与 Runtime 的字符估算保持相同单位，避免 UTF-8 字节数把中英文摘要区别对待。
func compactionUTF16Len(text string) int {
	n := 0
	for _, r := range text {
		n += utf16.RuneLen(r)
	}
	return n
}

func compactionContentChars(raw json.RawMessage) int {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return compactionUTF16Len(text)
	}
	var blocks []struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		Thinking  string          `json:"thinking"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return 0
	}
	size := 0
	for _, block := range blocks {
		switch block.Type {
		case "text":
			size += compactionUTF16Len(block.Text)
		case "thinking":
			size += compactionUTF16Len(block.Thinking)
		case "toolCall":
			var args bytes.Buffer
			_ = json.Compact(&args, block.Arguments)
			size += compactionUTF16Len(block.Name) + compactionUTF16Len(args.String())
		case "image":
			size += 4800
		}
	}
	return size
}

func projectClearedToolText(seq int64) string {
	return fmt.Sprintf("[工具结果已清除，原文为第 %d 条。需要时用 history.read 读取，或重新调用工具获取最新状态]", seq)
}

func compactionFrame(p projectagent.Compaction) string {
	if p.ThroughSeq == 0 && p.Summary == "" {
		return ""
	}
	return fmt.Sprintf("[程序说明] 以下摘要替换了第 1～%d 条对话。原文可用 history.read 按序号读取，history.search 按关键字搜索。\n<项目记忆索引>%s</项目记忆索引>\n<对话摘要>%s</对话摘要>", p.ThroughSeq, p.MemoryIndex, p.Summary)
}

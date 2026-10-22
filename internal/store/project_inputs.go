package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"unicode/utf8"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// insertProjectInput 同一事务保存业务变化和通知，不锁 Agent，避免与 Thread 报告路径形成反向锁。
func insertProjectInput(ctx context.Context, tx pgx.Tx, employeeID, agentID, kind, key string, payload any) error {
	raw, err := protocol.MarshalJSON(payload)
	if err != nil {
		return err
	}
	maxBytes := 72 << 10
	switch kind {
	case "user_message":
	case "attention_answer":
		maxBytes = 32 << 10
	case "thread_reply", "thread_message_failed":
		maxBytes = 40 << 10
	case "turn_ended":
		maxBytes = 4 << 10
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) == nil && fields["command_result"] != nil {
			maxBytes = 72 << 10
		}
	case "memory_updated":
		maxBytes = 1 << 10
	case "project_updated":
		maxBytes = 4 << 10
	default:
		return projectagent.ErrInvalid
	}
	if len(raw) > maxBytes {
		return projectagent.ErrTooLarge
	}
	var fits bool
	if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)<=$2`, raw, maxBytes).Scan(&fits); err != nil {
		return err
	}
	if !fits {
		return projectagent.ErrTooLarge
	}
	hash := sha256.Sum256(raw)
	_, err = tx.Exec(ctx, `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash,wake_required)
 VALUES($1,$2,$3,$4,$5,$6,$3 IN ('user_message','attention_answer','turn_ended','thread_message_failed')) ON CONFLICT(agent_id,source_key) DO NOTHING`, employeeID, agentID, kind, key, raw, hash[:])
	return err
}

func boundedText(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	head, tail := limit/2, limit-limit/2
	for head > 0 && !utf8.RuneStart(s[head]) {
		head--
	}
	start := len(s) - tail
	for start < len(s) && !utf8.RuneStart(s[start]) {
		start++
	}
	return s[:head] + s[start:]
}

func projectUpdatedPayload(p projectagent.Project) any {
	// 通知容量固定为 4 KiB；超长目标保留首尾，完整目标仍由 Project API 返回。
	goal := p.Goal
	for limit := min(len(goal), 3<<10); ; limit = limit * 3 / 4 {
		out := struct {
			Title         string `json:"title"`
			Goal          string `json:"goal"`
			Version       int64  `json:"version"`
			OriginalBytes int    `json:"original_goal_bytes"`
			Truncated     bool   `json:"truncated"`
		}{p.Title, boundedText(goal, limit), p.Version, len(goal), limit < len(goal)}
		raw, _ := protocol.MarshalJSON(out)
		if len(raw)+64 <= 4<<10 {
			return out
		}
	}
}

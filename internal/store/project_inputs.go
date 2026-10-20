package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"

	"baton/internal/task"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// insertProjectInput 同一事务保存业务变化和通知，不锁 Agent，避免与任务终态路径形成反向锁。
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
	case "task_result", "user_task_result":
		maxBytes = 72 << 10
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
	_, err = tx.Exec(ctx, `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(agent_id,source_key) DO NOTHING`, employeeID, agentID, kind, key, raw, hash[:])
	return err
}

// ProjectTaskResultInput 保存任务结果或待核实状态的限长通知。
type ProjectTaskResultInput struct {
	CommandResult    *task.CommandResult `json:"command_result,omitempty"`
	UserOperation    json.RawMessage     `json:"user_operation,omitempty"`
	NotificationOnly bool                `json:"notification_only,omitempty"`
	TaskID           string              `json:"task_id"`
	Version          int64               `json:"version"`
	Status           string              `json:"status"`
	ExitCode         *int                `json:"exit_code,omitempty"`
	Text             string              `json:"text"`
	OriginalBytes    int                 `json:"original_bytes"`
	Truncated        bool                `json:"truncated"`
	FullContent      string              `json:"full_content,omitempty"`
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

// EnqueueProjectTaskResult 可在现有任务事务内调用，重发同一任务版本只入队一次。
func EnqueueProjectTaskResult(ctx context.Context, tx pgx.Tx, employeeID, agentID string, in ProjectTaskResultInput) error {
	if in.TaskID == "" || in.Version < 1 || len(in.Status) > 64 || !utf8.ValidString(in.Text) || strings.ContainsRune(in.Text, 0) {
		return projectagent.ErrInvalid
	}
	in.OriginalBytes = len(in.Text)
	original := in.Text
	limit := min(len(original), 32<<10)
	for {
		in.Text = boundedText(original, limit)
		in.Truncated = len(in.Text) < len(original)
		if in.Truncated {
			in.FullContent = "完整内容用 tasks.get 读取"
		}
		raw, err := protocol.MarshalJSON(in)
		if err != nil {
			return err
		}
		var size int
		if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)`, raw).Scan(&size); err != nil {
			return err
		}
		maxBytes := 40 << 10
		if in.CommandResult != nil {
			maxBytes = 72 << 10
		}
		if len(raw) <= maxBytes && size <= maxBytes {
			break
		}
		if limit == 0 {
			return projectagent.ErrTooLarge
		}
		limit = limit * 3 / 4
	}
	kind := "task_result"
	if in.NotificationOnly {
		kind = "user_task_result"
	}
	return insertProjectInput(ctx, tx, employeeID, agentID, kind, fmt.Sprintf("task:%s:result:%d", in.TaskID, in.Version), in)
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

// enqueueTaskTerminal 只读取任务与 Agent 归属，不取得 Agent 行锁。
func enqueueTaskTerminal(ctx context.Context, tx pgx.Tx, employeeID, taskID string) error {
	return enqueueProjectTaskUpdate(ctx, tx, employeeID, taskID, false)
}

func enqueueProjectTaskUpdate(ctx context.Context, tx pgx.Tx, employeeID, taskID string, includeNonterminal bool) error {
	var agentID, status string
	var passive bool
	var operation json.RawMessage
	var version int64
	var summary, message *string
	var command *task.CommandResult
	err := tx.QueryRow(ctx, `SELECT a.id::text,t.status,t.version,t.summary,t.error_message,t.origin_conversation_id IS NULL,t.user_operation,t.command_result
 FROM tasks t JOIN project_agents a ON a.project_id=t.project_id AND a.employee_id=t.employee_id
 WHERE t.employee_id=$1 AND t.id=$2 AND (t.status IN ('completed','failed','cancelled','needs_verification') OR $3)`, employeeID, taskID, includeNonterminal).Scan(&agentID, &status, &version, &summary, &message, &passive, &operation, &command)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	loaded := []task.Record{{TaskID: taskID}}
	if err = attachResults(ctx, tx, employeeID, loaded); err != nil {
		return err
	}
	var text strings.Builder
	if summary != nil {
		text.WriteString(*summary)
	}
	if message != nil {
		text.WriteString("\n")
		text.WriteString(*message)
	}
	for _, ref := range loaded[0].Evidence {
		raw, _ := protocol.MarshalJSON(ref)
		text.WriteString("\n")
		text.Write(raw)
	}
	return EnqueueProjectTaskResult(ctx, tx, employeeID, agentID, ProjectTaskResultInput{TaskID: taskID, Version: version, Status: status, Text: text.String(), NotificationOnly: passive, UserOperation: operation, CommandResult: command})
}

package store

import (
	"context"
	"encoding/json"
)

type ThreadTraceStep struct {
	Kind      string `json:"kind"`
	Command   string `json:"command,omitempty"`
	Output    string `json:"output,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}
type ThreadTrace struct {
	OK    bool              `json:"ok"`
	Code  string            `json:"code,omitempty"`
	Steps []ThreadTraceStep `json:"steps"`
}

// ThreadTrace 返回账本中可证明的命令和输出；Agent 工具过程未单独上报时明确标为缺失。
func (s *Store) ThreadTrace(ctx context.Context, employeeID, id string, seq int64) (ThreadTrace, error) {
	result := ThreadTrace{Code: "trace_missing", Steps: []ThreadTraceStep{}}
	if seq < 1 {
		return result, threadInvalid()
	}
	t, err := s.GetThread(ctx, employeeID, id)
	if err != nil {
		return result, err
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_turns WHERE employee_id=$1 AND thread_id=$2 AND worker_turn_seq=$3)`, employeeID, id, seq).Scan(&exists); err != nil {
		return result, err
	}
	if !exists {
		return result, ErrNotFound
	}
	if t.AgentType != "shell" {
		return result, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT m.content,r.content,r.metadata,r.truncated FROM thread_turns turn JOIN thread_messages m ON m.thread_id=turn.thread_id AND m.turn_id=turn.id JOIN thread_replies r ON r.turn_id=turn.id AND r.thread_id=turn.thread_id WHERE turn.employee_id=$1 AND turn.thread_id=$2 AND turn.worker_turn_seq=$3 ORDER BY r.created_at,r.id LIMIT 16`, employeeID, id, seq)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var step ThreadTraceStep
		var metadata []byte
		if err := rows.Scan(&step.Command, &step.Output, &metadata, &step.Truncated); err != nil {
			return result, err
		}
		var meta struct {
			Encoding string `json:"encoding"`
		}
		if json.Unmarshal(metadata, &meta) != nil || meta.Encoding != "" {
			continue
		}
		step.Kind = "command"
		result.Steps = append(result.Steps, step)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	if len(result.Steps) > 0 {
		result.OK = true
		result.Code = ""
	}
	return result, nil
}

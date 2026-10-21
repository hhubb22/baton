package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/task"
	"github.com/jackc/pgx/v5"
)

type projectToolPending struct {
	Pending         bool   `json:"pending"`
	ThreadID        string `json:"thread_id"`
	Version         int64  `json:"version"`
	WaitRemainingMS int64  `json:"wait_remaining_ms"`
	WaitProtocol    int    `json:"wait_protocol"`
}

const projectWaitRemainingSQL = `GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (exec_wait_until-clock_timestamp()))*1000))::bigint`

func readProjectToolPending(ctx context.Context, tx pgx.Tx, id string) (projectToolPending, error) {
	p := projectToolPending{Pending: true, ThreadID: id, WaitProtocol: 1}
	err := tx.QueryRow(ctx, `SELECT version,`+projectWaitRemainingSQL+` FROM threads WHERE id=$1`, id).Scan(&p.Version, &p.WaitRemainingMS)
	return p, err
}

func (s *Store) dispatchProjectExec(ctx context.Context, tx pgx.Tx, b projectRunBinding, callID string, a toolArguments) (any, error) {
	if a.NodeID == "" || a.WorkingDirectory == "" || strings.TrimSpace(a.Command) == "" {
		return nil, projectagent.ErrInvalid
	}
	wait, timeout := 30, 7200
	if a.WaitSeconds != nil {
		wait = *a.WaitSeconds
	}
	if a.TimeoutSeconds != nil {
		timeout = *a.TimeoutSeconds
	}
	if wait < 0 || wait > 600 || timeout < 1 || timeout > 2147483647 {
		return nil, projectagent.ErrInvalid
	}
	// 已保存的命令保持原来的 Thread 和等待期限。
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM threads WHERE employee_id=$1 AND project_id=$2 AND origin_conversation_id=$3 AND origin_tool_call_id=$4 AND agent_type='shell' FOR UPDATE`, b.owner, b.projectID, b.conversationID, callID).Scan(&id)
	if err == nil {
		return readProjectToolPending(ctx, tx, id)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err = projectExecEnabled(ctx, tx, b.owner, a.NodeID); err != nil {
		return nil, err
	}
	t, _, err := createThreadTx(ctx, tx, b.owner, projectThreadInput(b, callID, a.NodeID, "shell", a.WorkingDirectory, a.Command, timeout))
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE threads SET exec_wait_until=clock_timestamp()+$2*interval '1 second' WHERE id=$1`, t.ID, wait); err != nil {
		return nil, err
	}
	return readProjectToolPending(ctx, tx, t.ID)
}

// shell 能力独立于执行 Agent 列表，按本节点最新的显式开启报告判断。
func projectExecEnabled(ctx context.Context, tx pgx.Tx, employeeID, nodeID string) error {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT COALESCE((r.report->'exec'->>'enabled')::boolean,false) FROM nodes n LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.id=$1 AND n.employee_id=$2 AND n.revoked_at IS NULL`, nodeID, employeeID).Scan(&enabled)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !enabled {
		return &task.Rejection{Code: task.CodeUnsupported, Message: "目标节点未开启 Project Agent 命令执行", Fields: []string{"node_id"}}
	}
	return nil
}

func (s *Store) waitProjectTool(ctx context.Context, tx pgx.Tx, b projectRunBinding, req protocol.ProjectRuntimeRequest) (any, error) {
	if req.ToolCallID == "" || len(req.ToolCallID) > 128 {
		return nil, projectagent.ErrInvalid
	}
	if err := tx.QueryRow(ctx, `SELECT next_seq FROM conversations WHERE id=$1 FOR UPDATE`, b.conversationID).Scan(&b.nextSeq); err != nil {
		return nil, err
	}
	old, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND kind='tool_result' AND tool_call_id=$2`, b.conversationID, req.ToolCallID))
	if err == nil {
		return old, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if req.LastSeq != b.nextSeq-1 {
		return nil, projectagent.ErrConflict
	}
	var force struct {
		Finish bool `json:"finish_wait"`
	}
	if len(req.Payload) > 0 && protocol.DecodeRuntimeJSON(req.Payload, &force) != nil {
		return nil, projectagent.ErrInvalid
	}
	if err = validateProjectExecCall(ctx, tx, b, req.ToolCallID); err != nil {
		return nil, err
	}
	// 先锁 Thread，再读取终态；报告事务也持有同一个 Thread 锁。
	var id, status string
	var version int64
	var deadline time.Time
	err = tx.QueryRow(ctx, `SELECT id::text,status,version,exec_wait_until FROM threads WHERE employee_id=$1 AND project_id=$2 AND origin_conversation_id=$3 AND origin_tool_call_id=$4 AND agent_type='shell' FOR UPDATE`, b.owner, b.projectID, b.conversationID, req.ToolCallID).Scan(&id, &status, &version, &deadline)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, projectagent.ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	var ended, expired bool
	var remaining int64
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=$1 AND ended_at IS NOT NULL),clock_timestamp()>=$2,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz-clock_timestamp()))*1000))::bigint`, id, deadline).Scan(&ended, &expired, &remaining); err != nil {
		return nil, err
	}
	terminal := ended || status == "stopped" || status == "unknown" || status == "archived"
	if !terminal && !expired && !force.Finish {
		return projectToolPending{Pending: true, ThreadID: id, Version: version, WaitRemainingMS: remaining, WaitProtocol: 1}, nil
	}
	output := map[string]any{"thread_id": id, "status": status, "version": version, "read_tool": "threads.read"}
	if terminal {
		command, err := shellThreadCommandResult(ctx, tx, b.owner, id)
		if err != nil {
			return nil, err
		}
		output["command_result"] = command
	} else {
		output["message"] = fmt.Sprintf("仍在执行，Thread ID 为 %s，结束后输出会作为新输入送回", id)
	}
	if status == "unknown" {
		output["message"] = "命令状态不确定，不会自动重试；请查看 Thread " + id
	}
	// 工具结果有 32 KiB 上限；原始回复可通过 threads.read 分页读取。
	if err = boundShellToolResult(output, req.ToolCallID); err != nil {
		return nil, err
	}
	e, err := saveProjectToolResult(ctx, tx, b, req, req.ToolCallID, "nodes.exec", output, false)
	if err != nil {
		return nil, err
	}
	if terminal {
		_, err = tx.Exec(ctx, `UPDATE project_agent_input_queue SET delivered_seq=$3,wake_required=false WHERE agent_id=$1 AND delivered_seq IS NULL AND payload->>'thread_id'=$2 AND ((source_type='turn_ended' AND source_key=$4) OR (source_type='thread_reply' AND payload->>'worker_turn_seq'='1'))`, b.agentID, id, e.Seq, fmt.Sprintf("thread:%s:turn:1", id))
	}
	return e, err
}

func shellThreadCommandResult(ctx context.Context, tx pgx.Tx, owner, id string) (map[string]any, error) {
	rows, err := tx.Query(ctx, `SELECT content,truncated,original_bytes,metadata FROM thread_replies WHERE employee_id=$1 AND thread_id=$2 AND worker_turn_seq=1 ORDER BY worker_seq`, owner, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]any{"output": "", "total_bytes": int64(0), "truncated": false}
	var output strings.Builder
	var total int64
	var truncated bool
	for rows.Next() {
		var content string
		var cut bool
		var size int64
		var raw []byte
		if err = rows.Scan(&content, &cut, &size, &raw); err != nil {
			return nil, err
		}
		var metadata map[string]any
		if err = json.Unmarshal(raw, &metadata); err != nil {
			return nil, err
		}
		for _, key := range []string{"exit_code", "encoding"} {
			if v, ok := metadata[key]; ok {
				out[key] = v
			}
		}
		output.WriteString(content)
		total += size
		truncated = truncated || cut
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out["output"] = output.String()
	out["total_bytes"] = total
	out["truncated"] = truncated
	return out, nil
}

func boundShellToolResult(output map[string]any, callID string) error {
	command, ok := output["command_result"].(map[string]any)
	if !ok {
		return nil
	}
	original, _ := command["output"].(string)
	for limit := len(original); ; limit = limit * 3 / 4 {
		if command["encoding"] == "base64" && limit < len(original) {
			limit = limit / 8 * 8
		}
		command["output"] = boundedText(original, limit)
		if limit < len(original) {
			command["truncated"] = true
		}
		text, err := protocol.MarshalJSON(output)
		if err != nil {
			return err
		}
		raw, err := protocol.MarshalJSON(map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "toolResult", "toolCallId": callID, "toolName": "nodes.exec", "content": []any{map[string]any{"type": "text", "text": string(text)}}, "isError": false, "timestamp": 0}})
		if err != nil {
			return err
		}
		if len(raw) <= maxProjectToolBytes {
			return nil
		}
		if limit == 0 {
			return projectagent.ErrTooLarge
		}
	}
}

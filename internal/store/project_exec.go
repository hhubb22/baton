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
	TaskID          string `json:"task_id"`
	TaskVersion     int64  `json:"task_version"`
	WaitRemainingMS int64  `json:"wait_remaining_ms"`
	WaitProtocol    int    `json:"wait_protocol"`
}

const projectWaitRemainingSQL = `GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (exec_wait_until-clock_timestamp()))*1000))::bigint`

func readProjectToolPending(ctx context.Context, tx pgx.Tx, id string) (projectToolPending, error) {
	p := projectToolPending{Pending: true, TaskID: id, WaitProtocol: 1}
	err := tx.QueryRow(ctx, `SELECT version,`+projectWaitRemainingSQL+` FROM tasks WHERE id=$1`, id).Scan(&p.TaskVersion, &p.WaitRemainingMS)
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
	if wait < 0 || wait > 600 || timeout < 1 {
		return nil, projectagent.ErrInvalid
	}
	// 已接受的调用先返回原任务，能力变化不触发新执行或改写等待期限。
	var id string
	err := tx.QueryRow(ctx, `SELECT id::text FROM tasks WHERE employee_id=$1 AND origin_conversation_id=$2 AND origin_tool_call_id=$3 FOR UPDATE`, b.owner, b.conversationID, callID).Scan(&id)
	if err == nil {
		return readProjectToolPending(ctx, tx, id)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	agentType := "shell"
	input := task.Input{RequestID: fmt.Sprintf("pa:%s:%s", b.conversationID, callID), TargetNodeID: &a.NodeID, AgentType: &agentType, WorkingDirectory: &a.WorkingDirectory, Description: a.Command, ExecutionTimeoutSeconds: &timeout}
	prepared, err := task.Prepare(input)
	if err != nil {
		return nil, err
	}
	rec, _, err := s.acceptOnceTx(ctx, tx, b.owner, prepared, nil)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `UPDATE tasks SET project_id=$2,origin_conversation_id=$3,origin_tool_call_id=$4,exec_wait_until=clock_timestamp()+$5*interval '1 second' WHERE id=$1`, rec.TaskID, b.projectID, b.conversationID, callID, wait)
	if err != nil {
		return nil, err
	}
	return readProjectToolPending(ctx, tx, rec.TaskID)
}

// shell 能力独立于执行 Agent 列表，按本节点最新的显式开启报告判断。
func projectExecEnabled(ctx context.Context, tx pgx.Tx, employeeID, nodeID string) error {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT COALESCE((r.report->'exec'->>'enabled')::boolean,false) FROM nodes n LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.id=$1 AND n.employee_id=$2 AND n.revoked_at IS NULL`, nodeID, employeeID).Scan(&enabled)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !enabled {
		return &task.Rejection{Code: task.CodeUnsupported, Message: "目标节点未开启 Project Agent 命令执行", Fields: []string{"target_node_id"}}
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
	// 与终态写入共用任务行锁；输入队列只在这之后加锁。
	var id, status string
	var version int64
	var deadline time.Time
	var summary *string
	var command json.RawMessage
	var operation json.RawMessage
	err = tx.QueryRow(ctx, `SELECT id::text,status,version,exec_wait_until,summary,command_result,user_operation FROM tasks WHERE employee_id=$1 AND project_id=$2 AND origin_conversation_id=$3 AND origin_tool_call_id=$4 AND agent_type='shell' FOR UPDATE`, b.owner, b.projectID, b.conversationID, req.ToolCallID).Scan(&id, &status, &version, &deadline, &summary, &command, &operation)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, projectagent.ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	terminal := status == task.StatusCompleted || status == task.StatusFailed || status == task.StatusCancelled
	var expired bool
	var remaining int64
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()>=$1,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000))::bigint`, deadline).Scan(&expired, &remaining); err != nil {
		return nil, err
	}
	uncertain := status == task.StatusNeedsVerification
	if !terminal && !uncertain && !expired && !force.Finish {
		return projectToolPending{Pending: true, TaskID: id, TaskVersion: version, WaitRemainingMS: remaining, WaitProtocol: 1}, nil
	}
	output := map[string]any{"task_id": id, "status": status, "read_tool": "tasks.get"}
	if len(operation) > 0 {
		output["user_operation"] = operation
	}
	if terminal || uncertain {
		output["version"] = version
		output["summary"] = summary
		if len(command) > 0 {
			output["command_result"] = command
		}
	}
	if !terminal {
		output["message"] = "仍在执行，结束后结果会作为新输入送回"
		if uncertain {
			output["message"] = "任务待核实，不会自动重试"
		}
	}
	e, err := saveProjectToolResult(ctx, tx, b, req, req.ToolCallID, "nodes.exec", output, false)
	if err != nil {
		return nil, err
	}
	if terminal || uncertain {
		_, err = tx.Exec(ctx, `UPDATE project_agent_input_queue SET delivered_seq=$3 WHERE agent_id=$1 AND source_key=$2 AND delivered_seq IS NULL`, b.agentID, fmt.Sprintf("task:%s:result:%d", id, version), e.Seq)
	}
	return e, err
}

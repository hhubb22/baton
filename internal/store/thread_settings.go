package store

import (
	"baton/internal/protocol"
	"context"
	"encoding/json"
)

// SetThreadModel 保存后续排队消息的默认模型，实际模型由 turn.started 报告确认。
func (s *Store) SetThreadModel(ctx context.Context, employeeID, id, model string) (ThreadView, error) {
	if !threadID(employeeID) || !threadID(id) || model == "" || !threadModel(model) {
		return ThreadView{}, threadInvalid()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ThreadView{}, err
	}
	defer tx.Rollback(ctx)
	t, err := readThread(ctx, tx, employeeID, id, true)
	if err != nil {
		return ThreadView{}, err
	}
	if t.Status == "archived" || t.ArchiveRequestedAt != nil {
		return ThreadView{}, threadConflict()
	}
	if err := threadNode(ctx, tx, employeeID, t.NodeID, t.AgentType, t.WorkingDirectory, false, &model, true); err != nil {
		return ThreadView{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE threads SET next_model=$2 WHERE id=$1`, id, model); err != nil {
		return ThreadView{}, err
	}
	if err := threadAudit(ctx, tx, t, "model.requested", "employee", employeeID, map[string]string{"model": model}); err != nil {
		return ThreadView{}, err
	}
	if err := touchThread(ctx, tx, id); err != nil {
		return ThreadView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ThreadView{}, err
	}
	return s.GetThread(ctx, employeeID, id)
}

func (s *Store) ResumeThread(ctx context.Context, employeeID, id string) (ThreadView, error) {
	if !threadID(employeeID) || !threadID(id) {
		return ThreadView{}, threadInvalid()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ThreadView{}, err
	}
	defer tx.Rollback(ctx)
	t, err := readThread(ctx, tx, employeeID, id, true)
	if err != nil {
		return ThreadView{}, err
	}
	if t.Status == "archived" || t.ArchiveRequestedAt != nil || t.OpenedAt == nil {
		return ThreadView{}, threadConflict()
	}
	if t.Status != "stopped" && t.Status != "idle" {
		return ThreadView{}, threadError(409, "resume_conflict", "请等待当前执行或停止完成")
	}
	if t.StopRequestedAt != nil && t.StopConfirmedAt == nil {
		return ThreadView{}, threadError(409, "stop_pending", "设备尚未确认停止")
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT report FROM node_runtime_reports rr JOIN nodes n ON n.id=rr.node_id WHERE n.id=$1 AND n.employee_id=$2 AND n.revoked_at IS NULL`, t.NodeID, employeeID).Scan(&raw); err != nil {
		return ThreadView{}, threadError(422, "resume_unsupported", "设备未报告恢复能力")
	}
	var report protocol.RuntimeReport
	if json.Unmarshal(raw, &report) != nil {
		return ThreadView{}, threadInvalid()
	}
	supported := false
	for _, a := range report.Agents {
		if a.AgentType == t.AgentType && a.Status == "available" && a.Capabilities.Resume {
			supported = true
		}
	}
	if !supported || t.AgentType == "shell" {
		return ThreadView{}, threadError(422, "resume_unsupported", "该 Agent 未报告恢复能力")
	}
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_outbox WHERE thread_id=$1 AND action='resume' AND acked_at IS NULL)`, id).Scan(&pending); err != nil {
		return ThreadView{}, err
	}
	if !pending {
		if err := enqueueThreadCommand(ctx, tx, t, "resume", map[string]any{}); err != nil {
			return ThreadView{}, err
		}
		if err := threadAudit(ctx, tx, t, "resume.requested", "employee", employeeID, map[string]any{}); err != nil {
			return ThreadView{}, err
		}
		if err := touchThread(ctx, tx, id); err != nil {
			return ThreadView{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ThreadView{}, err
	}
	return s.GetThread(ctx, employeeID, id)
}

package store

import (
	"context"
	"encoding/json"
	"errors"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/task"

	"github.com/jackc/pgx/v5"
)

func (s *Store) ChildDeliveries(ctx context.Context, source AgentSource, childID string) ([]protocol.ChildDelivery, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := validateAgentSource(ctx, tx, source); err != nil {
		return nil, err
	}
	if childID != "" {
		if _, err := identity.ParseUUID(childID); err != nil {
			return nil, agentDenied()
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO child_deliveries (id, employee_id, source_execution_id, child_execution_id)
      SELECT gen_random_uuid(), t.employee_id, $3::uuid, e.id FROM tasks t
      JOIN executions e ON e.task_id = t.id AND e.employee_id = t.employee_id
      WHERE t.employee_id = $1::uuid AND t.parent_task_id = $2::uuid
        AND t.source_session_id = $4::uuid
        AND (t.status IN ('completed', 'failed', 'cancelled') OR EXISTS
          (SELECT 1 FROM delivery_records d WHERE d.execution_id = e.id))
      ON CONFLICT (child_execution_id) DO NOTHING`, source.EmployeeID, source.TaskID, source.ExecutionID, source.SessionID)
	if err != nil {
		return nil, err
	}
	var id, deliveryID, executionID string
	err = tx.QueryRow(ctx, `SELECT t.id::text, d.id::text, e.id::text FROM child_deliveries d
      JOIN executions e ON e.id = d.child_execution_id JOIN tasks t ON t.id = e.task_id
      WHERE d.employee_id = $1::uuid AND d.source_execution_id = $2::uuid
        AND (($3 = '' AND d.status IN ('pending', 'available', 'source_stopped')) OR t.id::text = $3)
      ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'available' THEN 1 ELSE 2 END,
        d.created_at, d.id LIMIT 1`, source.EmployeeID, source.ExecutionID, childID).Scan(&id, &deliveryID, &executionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id = $1::uuid AND id = $2::uuid`, source.EmployeeID, id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, agentDenied()
	}
	records := []task.Record{rec}
	if err := attachResults(ctx, tx, source.EmployeeID, records); err != nil {
		return nil, err
	}
	rec = records[0]
	result := AgentResultView{TaskID: id, TargetNodeID: rec.TargetNodeID, SessionID: rec.TargetSessionID,
		ExecutionID: executionID, Status: rec.Status, Ready: true, Summary: rec.Summary,
		Evidence: rec.Evidence, Artifacts: rec.Artifacts,
		EvidenceEmptyReason: rec.EvidenceEmptyReason, ArtifactsEmptyReason: rec.ArtifactsEmptyReason}
	if result.Evidence == nil {
		result.Evidence = []task.ResultRef{}
	}
	if result.Artifacts == nil {
		result.Artifacts = []task.ResultRef{}
	}
	if rec.ErrorCode != nil {
		result.Error = &AgentResultError{Code: *rec.ErrorCode}
		if rec.ErrorMessage != nil {
			result.Error.Message = *rec.ErrorMessage
		}
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return []protocol.ChildDelivery{{DeliveryID: deliveryID, TaskID: source.TaskID, ExecutionID: source.ExecutionID,
		SessionID: source.SessionID, ChildTaskID: id, Result: raw}}, nil
}

// RecordChildReceipt 更新交付状态，不把交付不确定改成任务执行失败。
func (s *Store) RecordChildReceipt(ctx context.Context, source AgentSource, receipt protocol.ChildReceipt) error {
	if _, err := identity.ParseUUID(receipt.DeliveryID); err != nil {
		return agentDenied()
	}
	switch receipt.Status {
	case "available", "source_stopped":
		if receipt.Generation != 0 {
			return agentDenied()
		}
	case "delivered", "uncertain":
		if receipt.Generation < 2 {
			return agentDenied()
		}
	default:
		return agentDenied()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := validateAgentSource(ctx, tx, source); err != nil {
		return err
	}
	var status string
	var generation *int
	err = tx.QueryRow(ctx, `SELECT status, input_generation FROM child_deliveries
      WHERE id = $1::uuid AND employee_id = $2::uuid AND source_execution_id = $3::uuid FOR UPDATE`,
		receipt.DeliveryID, source.EmployeeID, source.ExecutionID).Scan(&status, &generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return agentDenied()
	}
	if err != nil {
		return err
	}
	if status == "delivered" || status == "uncertain" {
		if status != receipt.Status || generation == nil || *generation != receipt.Generation {
			return agentDenied()
		}
		return tx.Commit(ctx)
	}
	if receipt.Generation > 0 {
		tag, err := tx.Exec(ctx, `UPDATE executions SET input_generation = $2
          WHERE id = $1::uuid AND input_generation = $2 - 1`, source.ExecutionID, receipt.Generation)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return agentDenied()
		}
	}
	_, err = tx.Exec(ctx, `UPDATE child_deliveries SET status = $2, input_generation = NULLIF($3, 0), updated_at = now()
      WHERE id = $1::uuid`, receipt.DeliveryID, receipt.Status, receipt.Generation)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

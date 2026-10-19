package store

import (
	"context"
	"errors"

	"baton/internal/protocol"

	"github.com/jackc/pgx/v5"
)

// SaveRuntimeReport 只接受当前已同步连接，按内容变化增加版本；重发相同内容不增加版本。
func (s *Store) SaveRuntimeReport(ctx context.Context, src protocol.Source, report protocol.RuntimeReport) (int64, error) {
	raw, err := protocol.RuntimeReportJSON(report)
	if err != nil {
		return 0, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT id::text FROM nodes WHERE id=$1::uuid AND employee_id=$2::uuid AND revoked_at IS NULL FOR UPDATE`, src.NodeID, src.EmployeeID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrSyncRejected
	}
	if err != nil {
		return 0, err
	}
	err = tx.QueryRow(ctx, `SELECT p.node_id::text FROM node_presence p
 JOIN node_credentials c ON c.node_id=p.node_id AND c.employee_id=p.employee_id
 WHERE p.node_id=$1::uuid AND p.employee_id=$2::uuid AND p.conn_id=$3 AND p.online AND p.synced
 AND c.id=$4::uuid AND c.revoked_at IS NULL AND c.expires_at>now() FOR UPDATE OF p`, src.NodeID, src.EmployeeID, src.ConnID, src.CredentialID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrSyncRejected
	}
	if err != nil {
		return 0, err
	}
	var version int64
	err = tx.QueryRow(ctx, `INSERT INTO node_runtime_reports(node_id,employee_id,report_version,reported_at,report)
 VALUES($1::uuid,$2::uuid,1,now(),$3::jsonb)
 ON CONFLICT(node_id) DO UPDATE SET
 report_version=node_runtime_reports.report_version + CASE WHEN node_runtime_reports.report=EXCLUDED.report THEN 0 ELSE 1 END,
 reported_at=now(),report=EXCLUDED.report
 RETURNING report_version`, src.NodeID, src.EmployeeID, raw).Scan(&version)
	if err != nil {
		return 0, err
	}
	return version, tx.Commit(ctx)
}

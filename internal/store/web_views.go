package store

import (
	"baton/internal/identity"
	"baton/internal/projectagent"
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"time"
)

type EnrollmentView struct {
	EnrollmentID string    `json:"enrollment_id"`
	State        string    `json:"state"`
	DeviceID     *string   `json:"device_id"`
	ExpiresAt    time.Time `json:"expires_at"`
	ExpiresInMS  int64     `json:"expires_in_ms"`
}

// OwnEnrollment 仅查询本人的注册状态；凭据核销后保留设备关联。
func (s *Store) OwnEnrollment(ctx context.Context, employeeID, enrollmentID string) (EnrollmentView, error) {
	var v EnrollmentView
	if _, err := identity.ParseUUID(enrollmentID); err != nil {
		return v, ErrNotFound
	}
	err := s.pool.QueryRow(ctx, `SELECT e.id::text,e.device_id::text,e.expires_at,
 CASE WHEN e.used_at IS NOT NULL THEN
 CASE WHEN EXISTS(SELECT 1 FROM nodes n JOIN node_presence p ON p.node_id=n.id AND p.employee_id=n.employee_id WHERE n.id=e.device_id AND n.employee_id=e.employee_id AND n.revoked_at IS NULL AND p.online AND p.synced) THEN 'connected' ELSE 'used' END
 WHEN e.expires_at<=now() THEN 'expired' ELSE 'pending' END
 FROM node_enrollments e WHERE e.employee_id=$1::uuid AND e.id=$2::uuid`, employeeID, enrollmentID).Scan(&v.EnrollmentID, &v.DeviceID, &v.ExpiresAt, &v.State)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	v.ExpiresInMS = max(int64(0), time.Until(v.ExpiresAt).Milliseconds())
	return v, err
}

type MemoryRevision struct {
	Revision  int64     `json:"revision"`
	Content   string    `json:"content"`
	Title     *string   `json:"title"`
	Author    string    `json:"author"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) ProjectMemoryRevisions(ctx context.Context, employeeID, projectID, entryID string, after int64, limit int) ([]MemoryRevision, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return nil, projectagent.ErrInvalid
	}
	if _, err := s.ProjectMemory(ctx, employeeID, projectID, entryID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT r.revision,r.content,r.title,r.author,r.created_at FROM project_memory_revisions r JOIN project_memory_entries e ON e.id=r.entry_id AND e.employee_id=r.employee_id WHERE e.employee_id=$1 AND e.project_id=$2 AND e.id=$3 AND r.revision>$4 ORDER BY r.revision LIMIT $5`, employeeID, projectID, entryID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MemoryRevision{}
	for rows.Next() {
		var v MemoryRevision
		if err := rows.Scan(&v.Revision, &v.Content, &v.Title, &v.Author, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

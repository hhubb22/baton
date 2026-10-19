package store

import (
	"context"
	"errors"
	"fmt"
	"math"

	"baton/internal/projectagent"

	"github.com/jackc/pgx/v5"
)

const memorySelect = `SELECT e.id::text, e.title, r.content, e.current_revision, r.author, r.source_seq, e.updated_at
    FROM project_memory_entries e JOIN project_memory_revisions r
    ON r.employee_id=e.employee_id AND r.entry_id=e.id AND r.revision=e.current_revision`

func scanMemory(row pgx.Row) (projectagent.Memory, error) {
	var m projectagent.Memory
	err := row.Scan(&m.ID, &m.Title, &m.Content, &m.Revision, &m.Author, &m.SourceSeq, &m.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	return m, err
}

func (s *Store) ProjectMemory(ctx context.Context, employeeID, projectID, entryID string) (projectagent.Memory, error) {
	return scanMemory(s.pool.QueryRow(ctx, memorySelect+` WHERE e.employee_id=$1 AND e.project_id=$2 AND e.id=$3`, employeeID, projectID, entryID))
}

func (s *Store) ListProjectMemory(ctx context.Context, employeeID, projectID, afterID string, limit int) ([]projectagent.Memory, error) {
	if limit < 1 || limit > 100 {
		return nil, projectagent.ErrInvalid
	}
	if _, err := s.Project(ctx, employeeID, projectID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, memorySelect+` WHERE e.employee_id=$1 AND e.project_id=$2 AND ($3::uuid IS NULL OR e.id>$3::uuid) ORDER BY e.id LIMIT $4`,
		employeeID, projectID, nullableProjectID(afterID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []projectagent.Memory{}
	for rows.Next() {
		m, err := scanMemory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// WriteProjectMemory 由员工 API 或通过运行身份校验的工具调用。Author 由调用方决定，不能取自员工请求正文。
// expected_revision=0 创建条目；条目锁保证同一版本只有一个写入者成功。
func (s *Store) WriteProjectMemory(ctx context.Context, employeeID, projectID, entryID string, in projectagent.MemoryWrite) (projectagent.Memory, error) {
	var out projectagent.Memory
	if err := in.Validate(); err != nil {
		return out, err
	}
	if in.ExpectedRevision == math.MaxInt64 {
		return out, projectagent.ErrInvalid
	}
	p, err := s.Project(ctx, employeeID, projectID)
	if err != nil {
		return out, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.SourceSeq != nil {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE employee_id=$1 AND conversation_id=$2 AND seq=$3)`,
			employeeID, p.Conversation.ID, *in.SourceSeq).Scan(&exists); err != nil {
			return out, err
		}
		if !exists {
			return out, projectagent.ErrInvalid
		}
	}
	created := false
	if in.ExpectedRevision == 0 {
		tag, err := tx.Exec(ctx, `INSERT INTO project_memory_entries(id, employee_id, project_id, title, current_revision)
            VALUES($1,$2,$3,$4,1) ON CONFLICT(id) DO NOTHING`, entryID, employeeID, projectID, in.Title)
		if err != nil {
			return out, err
		}
		created = tag.RowsAffected() == 1
	}
	if !created {
		// 分两条语句读锁与内容，确保等待并发事务后读到它提交的新修订。
		var revision int64
		err = tx.QueryRow(ctx, `SELECT current_revision FROM project_memory_entries WHERE employee_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`,
			employeeID, projectID, entryID).Scan(&revision)
		if errors.Is(err, pgx.ErrNoRows) {
			if in.ExpectedRevision == 0 {
				return out, ErrNotFound
			}
			return out, &projectagent.MemoryConflict{}
		}
		if err != nil {
			return out, err
		}
		if revision != in.ExpectedRevision {
			current, err := scanMemory(tx.QueryRow(ctx, memorySelect+` WHERE e.employee_id=$1 AND e.project_id=$2 AND e.id=$3`, employeeID, projectID, entryID))
			if err != nil {
				return out, err
			}
			return out, &projectagent.MemoryConflict{Current: &current}
		}
	}
	revision := in.ExpectedRevision + 1
	if _, err = tx.Exec(ctx, `INSERT INTO project_memory_revisions(entry_id, employee_id, revision, content, author, source_seq)
        VALUES($1,$2,$3,$4,$5,$6)`, entryID, employeeID, revision, in.Content, in.Author, in.SourceSeq); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE project_memory_entries SET title=$4, current_revision=$5, updated_at=clock_timestamp()
        WHERE employee_id=$1 AND project_id=$2 AND id=$3`, employeeID, projectID, entryID, in.Title, revision); err != nil {
		return out, err
	}
	out, err = scanMemory(tx.QueryRow(ctx, memorySelect+` WHERE e.employee_id=$1 AND e.project_id=$2 AND e.id=$3`, employeeID, projectID, entryID))
	if err != nil {
		return out, err
	}
	if in.Author == "user" {
		notification := struct {
			EntryID  string `json:"entry_id"`
			Title    string `json:"title"`
			Revision int64  `json:"revision"`
			Author   string `json:"author"`
		}{entryID, in.Title, revision, "user"}
		if err = insertProjectInput(ctx, tx, employeeID, p.Agent.ID, "memory_updated", fmt.Sprintf("memory:%s:rev:%d", entryID, revision), notification); err != nil {
			return out, err
		}
	}
	return out, tx.Commit(ctx)
}

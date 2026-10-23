package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Store) GetThread(ctx context.Context, employeeID, id string) (ThreadView, error) {
	var view ThreadView
	view.PendingMessages = []ThreadMessage{}
	view.FailedMessages = []ThreadMessage{}
	if !threadID(employeeID) || !threadID(id) {
		return view, threadInvalid()
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return view, err
	}
	defer tx.Rollback(ctx)
	view, err = threadDetailTx(ctx, tx, employeeID, id)
	if err != nil {
		return view, err
	}
	return view, tx.Commit(ctx)
}

func threadDetailTx(ctx context.Context, tx pgx.Tx, employeeID, id string) (ThreadView, error) {
	view := ThreadView{PendingMessages: []ThreadMessage{}, FailedMessages: []ThreadMessage{}}
	var err error
	view.Thread, err = readThread(ctx, tx, employeeID, id, false)
	if err != nil {
		return view, err
	}
	rows, err := tx.Query(ctx, `SELECT to_jsonb(v) FROM thread_turns v WHERE employee_id=$1 AND thread_id=$2 AND ended_at IS NULL`, employeeID, id)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var raw []byte
		var turn ThreadTurn
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal(raw, &turn)
		}
		if err != nil {
			rows.Close()
			return view, err
		}
		view.CurrentTurn = &turn
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return view, err
	}
	rows, err = tx.Query(ctx, `SELECT to_jsonb(m) FROM thread_messages m WHERE employee_id=$1 AND thread_id=$2 AND (status IN ('accepted','queued','unknown') OR (status='withdrawn' AND status_reason<>'')) ORDER BY created_at,id`, employeeID, id)
	if err != nil {
		return view, err
	}
	for rows.Next() {
		var raw []byte
		var m ThreadMessage
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal(raw, &m)
		}
		if err != nil {
			rows.Close()
			return view, err
		}
		if m.Status == "withdrawn" {
			view.FailedMessages = append(view.FailedMessages, m)
		} else {
			view.PendingMessages = append(view.PendingMessages, m)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return view, err
	}
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_outbox WHERE employee_id=$1 AND thread_id=$2 AND action='resume' AND acked_at IS NULL)`, employeeID, id).Scan(&view.ResumePending); err != nil {
		return view, err
	}
	return view, nil
}

type threadListCursor struct {
	At                                  time.Time
	ID, Employee, Project, Node, Status string
}

func threadStatus(status string) bool {
	switch status {
	case "waiting_device", "running", "idle", "stopped", "unknown", "archived":
		return true
	}
	return false
}
func (s *Store) ListThreads(ctx context.Context, employeeID string, f ThreadFilter) (ThreadPage, error) {
	page := ThreadPage{Threads: []ThreadSummary{}}
	if !threadID(employeeID) || (f.ProjectID != "" && !threadID(f.ProjectID)) || (f.NodeID != "" && !threadID(f.NodeID)) || (f.Status != "" && !threadStatus(f.Status)) {
		return page, threadInvalid()
	}
	if f.Limit == 0 {
		f.Limit = 50
	}
	if f.Limit < 1 || f.Limit > 100 {
		return page, threadInvalid()
	}
	var at any
	var id any
	if f.Cursor != "" {
		var c threadListCursor
		raw, err := base64.RawURLEncoding.DecodeString(f.Cursor)
		if err != nil || len(raw) > 1024 || json.Unmarshal(raw, &c) != nil || !threadID(c.ID) || c.At.IsZero() || c.Employee != employeeID || c.Project != f.ProjectID || c.Node != f.NodeID || c.Status != f.Status {
			return page, threadInvalid()
		}
		at = c.At
		id = c.ID
	}
	rows, err := s.pool.Query(ctx, `SELECT `+threadJSON+` || jsonb_build_object(
 'title',COALESCE(NULLIF((
   SELECT left(split_part(e.payload->>'content',chr(10),1),120)
   FROM thread_events e WHERE e.employee_id=t.employee_id AND e.thread_id=t.id AND e.kind='message.accepted'
   ORDER BY e.id LIMIT 1
 ),''),NULLIF(t.working_directory,''),t.id::text),
 'stop_canceled',(
   SELECT count(*) FROM thread_events e
   WHERE e.employee_id=t.employee_id AND e.thread_id=t.id AND e.kind='message.withdrawn'
   AND e.id>(SELECT s.id FROM thread_events s
     WHERE s.employee_id=t.employee_id AND s.thread_id=t.id AND s.kind IN ('stop.requested','archive.requested')
     ORDER BY s.id DESC LIMIT 1)
 ),
 'current_turn',(
   SELECT to_jsonb(v) FROM thread_turns v
   WHERE v.employee_id=t.employee_id AND v.thread_id=t.id AND v.ended_at IS NULL
 )) FROM (
 SELECT * FROM threads
 WHERE employee_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::uuid IS NULL OR node_id=$3)
 AND ($4='' OR status=$4) AND ($5::timestamptz IS NULL OR (last_activity_at,id)<($5::timestamptz,$6::uuid))
 ORDER BY last_activity_at DESC,id DESC LIMIT $7
 ) t LEFT JOIN node_presence p ON p.node_id=t.node_id
 ORDER BY t.last_activity_at DESC,t.id DESC`, employeeID, nullableProjectID(f.ProjectID), nullableProjectID(f.NodeID), f.Status, at, id, f.Limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var t ThreadSummary
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal(raw, &t)
		}
		if err != nil {
			return page, err
		}
		page.Threads = append(page.Threads, t)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Threads) > f.Limit {
		page.Threads = page.Threads[:f.Limit]
		last := page.Threads[len(page.Threads)-1]
		raw, _ := json.Marshal(threadListCursor{At: last.LastActivityAt, ID: last.ID, Employee: employeeID, Project: f.ProjectID, Node: f.NodeID, Status: f.Status})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	return page, nil
}
func (s *Store) ThreadTimeline(ctx context.Context, employeeID, id, cursor string, limit int) (ThreadTimeline, error) {
	page := ThreadTimeline{Events: []ThreadEvent{}}
	if !threadID(employeeID) || !threadID(id) {
		return page, threadInvalid()
	}
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 {
		return page, threadInvalid()
	}
	var after int64
	var err error
	if cursor != "" {
		after, err = strconv.ParseInt(cursor, 10, 64)
		if err != nil || after < 0 {
			return page, threadInvalid()
		}
	}
	if _, err = readThread(ctx, s.pool, employeeID, id, false); err != nil {
		return page, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,kind,actor,actor_id,payload,created_at FROM thread_events WHERE employee_id=$1 AND thread_id=$2 AND id>$3 ORDER BY id LIMIT $4`, employeeID, id, after, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var e ThreadEvent
		if err = rows.Scan(&e.ID, &e.Kind, &e.Actor, &e.ActorID, &e.Payload, &e.CreatedAt); err != nil {
			return page, err
		}
		page.Events = append(page.Events, e)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if len(page.Events) > limit {
		page.Events = page.Events[:limit]
		page.NextCursor = strconv.FormatInt(page.Events[len(page.Events)-1].ID, 10)
	}
	return page, nil
}

func (s *Store) ThreadNotificationStamp(ctx context.Context, employeeID string) (string, error) {
	var stamp string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(sum(version),0)::text FROM threads WHERE employee_id=$1`, employeeID).Scan(&stamp)
	return stamp, err
}

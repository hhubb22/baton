package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"baton/internal/delivery"
	"baton/internal/identity"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type ThreadIntent struct {
	ThreadID  string
	NodeID    string
	MessageID string
	ConnID    string
	Envelope  json.RawMessage
}

func enqueueThreadCommand(ctx context.Context, tx pgx.Tx, t Thread, action string, payload any) error {
	id, err := identity.NewUUID()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action,payload) VALUES($1,$2,$3,$4,$5,$6)`, t.EmployeeID, t.ID, t.NodeID, id, action, raw)
	return err
}

// ClaimThreadCommands 按节点限额后再应用全局限额；提交退避后调用方才可入队。
func (s *Store) ClaimThreadCommands(ctx context.Context) ([]ThreadIntent, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	const due = `o.acked_at IS NULL AND o.next_attempt_at<=statement_timestamp()
 AND EXISTS(SELECT 1 FROM threads eligible WHERE eligible.id=o.thread_id
 AND (eligible.status<>'archived' OR o.action IN ('stop','withdraw'))
 AND (o.action IN ('open','stop') OR eligible.storage_generation IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM thread_outbox older WHERE older.thread_id=o.thread_id AND older.acked_at IS NULL AND older.id<o.id
 AND (eligible.status<>'archived' OR older.action IN ('stop','withdraw'))))`
	rows, err := tx.Query(ctx, `WITH candidates AS MATERIALIZED (
 SELECT p.node_id,p.conn_id FROM node_presence p JOIN nodes n ON n.id=p.node_id
 CROSS JOIN LATERAL (SELECT o.id,o.next_attempt_at FROM thread_outbox o WHERE o.node_id=p.node_id AND `+due+` ORDER BY o.next_attempt_at,o.id LIMIT 1) first_due
 WHERE p.online AND p.synced AND n.revoked_at IS NULL ORDER BY first_due.next_attempt_at,first_due.id
 ) SELECT command.* FROM candidates p CROSS JOIN LATERAL (
 SELECT o.id,o.message_id::text,o.action,o.payload,o.attempts,p.conn_id,to_jsonb(t)-'request_hash',clock_timestamp()
 FROM (SELECT o.* FROM thread_outbox o WHERE o.node_id=p.node_id AND `+due+`
 ORDER BY o.next_attempt_at,o.id FOR UPDATE OF o SKIP LOCKED) o
 CROSS JOIN LATERAL (SELECT t.* FROM threads t WHERE t.id=o.thread_id AND (t.status<>'archived' OR o.action IN ('stop','withdraw')) AND (o.action IN ('open','stop') OR t.storage_generation IS NOT NULL) FOR UPDATE OF t SKIP LOCKED) t
 LIMIT 4
 ) command LIMIT 32`)
	if err != nil {
		return nil, err
	}
	type claim struct {
		id                        int64
		messageID, action, connID string
		payload, thread           []byte
		attempts                  int
		now                       time.Time
	}
	claims := []claim{}
	for rows.Next() {
		var c claim
		if err = rows.Scan(&c.id, &c.messageID, &c.action, &c.payload, &c.attempts, &c.connID, &c.thread, &c.now); err != nil {
			rows.Close()
			return nil, err
		}
		claims = append(claims, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := make([]ThreadIntent, 0, len(claims))
	for _, c := range claims {
		var t Thread
		if err = json.Unmarshal(c.thread, &t); err != nil {
			return nil, err
		}
		cmd := protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: t.ID, Action: c.action, StorageGeneration: t.StorageGeneration}
		var payload struct {
			ClientMessageID string `json:"client_message_id"`
		}
		if err = json.Unmarshal(c.payload, &payload); err != nil {
			return nil, err
		}
		cmd.ClientMessageID = payload.ClientMessageID
		if c.action == "open" {
			cmd.AgentType = t.AgentType
			cmd.WorkingDirectory = t.WorkingDirectory
			cmd.ExecutionTimeoutSeconds = t.ExecutionTimeoutSeconds
		}
		if c.action == "message" {
			if err = tx.QueryRow(ctx, `SELECT content,mode FROM thread_messages WHERE employee_id=$1 AND thread_id=$2 AND client_message_id=$3`, t.EmployeeID, t.ID, payload.ClientMessageID).Scan(&cmd.Content, &cmd.Mode); err != nil {
				return nil, err
			}
		}
		body, err := protocol.MarshalJSON(cmd)
		if err != nil {
			return nil, err
		}
		env, err := protocol.MarshalJSON(protocol.Envelope{Version: protocol.Version, MessageID: c.messageID, Route: protocol.Route{To: t.NodeID}, Priority: protocol.PriorityControl, Body: body})
		if err != nil {
			return nil, err
		}
		if len(env) > protocol.MaxMessageBytes {
			return nil, protocol.ErrTooLarge
		}
		next := delivery.NextAttempt(c.now, c.attempts+1, time.Second)
		if _, err = tx.Exec(ctx, `UPDATE thread_outbox SET attempts=LEAST(attempts::bigint+1,2147483647)::integer,next_attempt_at=$2 WHERE id=$1`, c.id, next); err != nil {
			return nil, err
		}
		out = append(out, ThreadIntent{ThreadID: t.ID, NodeID: t.NodeID, MessageID: c.messageID, ConnID: c.connID, Envelope: env})
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// lockThreadSource 与吊销、连接替换按 Node → Credential → Presence 排序。
func lockThreadSource(ctx context.Context, tx pgx.Tx, src protocol.Source) error {
	if src.Kind != protocol.SourceNode || !threadID(src.NodeID) || !threadID(src.EmployeeID) || !threadID(src.CredentialID) || src.ConnID == "" {
		return ErrSyncRejected
	}
	checks := []struct {
		sql  string
		args []any
	}{
		{`SELECT id::text FROM nodes WHERE id=$1 AND employee_id=$2 AND revoked_at IS NULL FOR SHARE`, []any{src.NodeID, src.EmployeeID}},
		{`SELECT id::text FROM node_credentials WHERE id=$1 AND node_id=$2 AND employee_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`, []any{src.CredentialID, src.NodeID, src.EmployeeID}},
		{`SELECT node_id::text FROM node_presence WHERE node_id=$1 AND employee_id=$2 AND conn_id=$3 AND online AND synced FOR SHARE`, []any{src.NodeID, src.EmployeeID, src.ConnID}},
	}
	for _, c := range checks {
		var id string
		err := tx.QueryRow(ctx, c.sql, c.args...).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSyncRejected
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func checkThreadCredentialTime(ctx context.Context, tx pgx.Tx, src protocol.Source) error {
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT expires_at>clock_timestamp() FROM node_credentials WHERE id=$1`, src.CredentialID).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrSyncRejected
	}
	return nil
}

// SaveThreadCommandResult 不依赖内存 waiter，迟到回包仍可确认同一持久意图。
func (s *Store) SaveThreadCommandResult(ctx context.Context, src protocol.Source, messageID string, result protocol.ThreadCommandResult) error {
	if !threadID(messageID) || !threadID(result.ThreadID) || result.Type != protocol.BodyThreadCommandResult || len(result.Code) > 128 {
		return threadInvalid()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockThreadSource(ctx, tx, src); err != nil {
		return err
	}
	var raw []byte
	var acked *time.Time
	err = tx.QueryRow(ctx, `SELECT result,acked_at FROM thread_outbox WHERE message_id=$1 AND employee_id=$2 AND node_id=$3 AND thread_id=$4 FOR UPDATE`, messageID, src.EmployeeID, src.NodeID, result.ThreadID).Scan(&raw, &acked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err = checkThreadCredentialTime(ctx, tx, src); err != nil {
		return err
	}
	if acked != nil {
		return nil
	}
	raw, err = json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE thread_outbox SET acked_at=clock_timestamp(),result=$2 WHERE message_id=$1`, messageID, raw)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

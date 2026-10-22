package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
)

var threadReportKinds = map[string]bool{"thread.opened": true, "thread.open_failed": true, "message.queued": true, "message.sent": true, "message.withdrawn": true, "message.unknown": true, "turn.started": true, "reply": true, "turn.ended": true, "thread.stopped": true, "thread.unknown": true}
var threadEndReasons = map[string]bool{"completed": true, "stopped": true, "timeout": true, "agent_exited": true, "failed": true}

// SaveThreadReport 原子保存序号、回复、状态和 Project 输入，ACK 丢失可安全补报。
func (s *Store) SaveThreadReport(ctx context.Context, src protocol.Source, r protocol.ThreadReport) (protocol.ThreadReportResult, error) {
	ack := protocol.ThreadReportResult{Type: protocol.BodyThreadReportResult, ThreadID: r.ThreadID, EventID: r.EventID, WorkerSeq: r.WorkerSeq}
	if r.Type != protocol.BodyThreadReport || !threadID(r.ThreadID) || !threadID(r.EventID) || r.WorkerSeq < 1 || !threadReportKinds[r.Kind] || !utf8.ValidString(r.Content) || strings.ContainsRune(r.Content, 0) || len(r.Content) > 1<<20 || len(r.Reason) > 4096 || strings.ContainsRune(r.Reason, 0) || !threadModel(r.Model) {
		return ack, threadInvalid()
	}
	if r.HistoryUnavailable && r.Kind != "thread.stopped" && r.Kind != "thread.unknown" {
		return ack, threadInvalid()
	}
	raw, err := protocol.MarshalJSON(r)
	if err != nil {
		return ack, err
	}
	hash := sha256.Sum256(raw)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ack, err
	}
	defer tx.Rollback(ctx)
	if err = lockThreadSource(ctx, tx, src); err != nil {
		return ack, err
	}
	t, err := readThread(ctx, tx, src.EmployeeID, r.ThreadID, true)
	if err != nil {
		return ack, err
	}
	if t.NodeID != src.NodeID {
		return ack, ErrNotFound
	}
	if err = checkThreadCredentialTime(ctx, tx, src); err != nil {
		return ack, err
	}
	var oldHash, saved []byte
	err = tx.QueryRow(ctx, `SELECT payload_hash,ack FROM thread_reports WHERE employee_id=$1 AND thread_id=$2 AND event_id=$3`, src.EmployeeID, t.ID, r.EventID).Scan(&oldHash, &saved)
	if err == nil {
		if string(oldHash) != string(hash[:]) {
			return ack, threadConflict()
		}
		err = json.Unmarshal(saved, &ack)
		return ack, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ack, err
	}
	if r.WorkerSeq != t.LastWorkerSeq+1 {
		ack.Code = "worker_sequence_gap"
		ack.ExpectedWorkerSeq = t.LastWorkerSeq + 1
		return ack, nil
	}
	if t.Status == "archived" {
		return ack, threadConflict()
	}
	if err = applyThreadReport(ctx, tx, &t, &r); err != nil {
		return ack, err
	}
	if err = finishThreadArchive(ctx, tx, &t); err != nil {
		return ack, err
	}
	if _, err = tx.Exec(ctx, `UPDATE threads SET last_worker_seq=$2,last_reported_at=clock_timestamp(),last_activity_at=clock_timestamp(),version=version+1 WHERE id=$1`, t.ID, r.WorkerSeq); err != nil {
		return ack, err
	}
	if err = threadAudit(ctx, tx, t, r.Kind, "device", src.NodeID, r); err != nil {
		return ack, err
	}
	ack.OK = true
	saved, err = json.Marshal(ack)
	if err != nil {
		return ack, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO thread_reports(employee_id,thread_id,event_id,worker_seq,payload_hash,ack) VALUES($1,$2,$3,$4,$5,$6)`, src.EmployeeID, t.ID, r.EventID, r.WorkerSeq, hash[:], saved); err != nil {
		return ack, err
	}
	if err = checkThreadCredentialTime(ctx, tx, src); err != nil {
		return ack, err
	}
	return ack, tx.Commit(ctx)
}

func setThreadStatus(ctx context.Context, tx pgx.Tx, t *Thread, status, reason string) error {
	if t.Status == status && t.StatusReason == reason {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE threads SET status=$2,status_reason=$3 WHERE id=$1`, t.ID, status, reason)
	if err != nil {
		return err
	}
	t.Status = status
	t.StatusReason = reason
	return threadAudit(ctx, tx, *t, "status.changed", "device", t.NodeID, map[string]string{"status": status, "reason": reason})
}
func reportThreadTurn(ctx context.Context, tx pgx.Tx, t Thread, seq int64) (ThreadTurn, error) {
	var turn ThreadTurn
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT to_jsonb(v) FROM thread_turns v WHERE employee_id=$1 AND thread_id=$2 AND worker_turn_seq=$3`, t.EmployeeID, t.ID, seq).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return turn, threadConflict()
	}
	if err == nil {
		err = json.Unmarshal(raw, &turn)
	}
	return turn, err
}
func reportThreadMessage(ctx context.Context, tx pgx.Tx, t Thread, id string) (ThreadMessage, error) {
	var m ThreadMessage
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT to_jsonb(m) FROM thread_messages m WHERE employee_id=$1 AND thread_id=$2 AND client_message_id=$3`, t.EmployeeID, t.ID, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, threadConflict()
	}
	if err == nil {
		err = json.Unmarshal(raw, &m)
	}
	return m, err
}
func noActiveThreadTurn(ctx context.Context, tx pgx.Tx, id string) error {
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL)`, id).Scan(&active); err != nil {
		return err
	}
	if active {
		return threadConflict()
	}
	return nil
}

// endThreadTurnAfterHistoryLoss 结束中心已知的一轮，原 Worker 账本缺失时仍能通知 Project Agent。
func endThreadTurnAfterHistoryLoss(ctx context.Context, tx pgx.Tx, t Thread) error {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT to_jsonb(v) FROM thread_turns v WHERE employee_id=$1 AND thread_id=$2 AND ended_at IS NULL`, t.EmployeeID, t.ID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var turn ThreadTurn
	if err := json.Unmarshal(raw, &turn); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE thread_turns SET ended_at=clock_timestamp(),end_reason='agent_exited' WHERE id=$1`, turn.ID); err != nil {
		return err
	}
	if err := enqueueThreadTurnEnded(ctx, tx, t, turn, "agent_exited"); err != nil {
		return err
	}
	return threadAudit(ctx, tx, t, "turn.ended", "device", t.NodeID, map[string]any{
		"worker_turn_seq": turn.WorkerTurnSeq, "reason": "agent_exited", "history_unavailable": true,
	})
}

func setThreadModel(ctx context.Context, tx pgx.Tx, t *Thread, model string) error {
	if model == "" || model == t.Model {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE threads SET model=$2 WHERE id=$1`, t.ID, model); err != nil {
		return err
	}
	t.Model = model
	return nil
}

func applyThreadReport(ctx context.Context, tx pgx.Tx, t *Thread, r *protocol.ThreadReport) error {
	switch r.Kind {
	case "thread.opened":
		if t.OpenedAt != nil || t.Status != "waiting_device" || !threadKey(r.StorageGeneration) || (r.NativeSessionID != "" && !threadText(r.NativeSessionID, 4096)) {
			return threadConflict()
		}
		_, err := tx.Exec(ctx, `UPDATE threads SET storage_generation=$2,native_session_id=$3,opened_at=clock_timestamp() WHERE id=$1`, t.ID, r.StorageGeneration, r.NativeSessionID)
		if err != nil {
			return err
		}
		if err = setThreadModel(ctx, tx, t, r.Model); err != nil {
			return err
		}
		return setThreadStatus(ctx, tx, t, "idle", "")
	case "thread.open_failed":
		if err := noActiveThreadTurn(ctx, tx, t.ID); err != nil {
			return err
		}
		if t.OpenedAt == nil {
			tag, err := tx.Exec(ctx, `UPDATE thread_messages m SET status='withdrawn' WHERE m.thread_id=$1 AND m.status='accepted' AND EXISTS(SELECT 1 FROM thread_outbox o WHERE o.thread_id=m.thread_id AND o.action='message' AND o.payload->>'client_message_id'=m.client_message_id AND o.attempts=0)`, t.ID)
			if err != nil {
				return err
			}
			if err = threadAudit(ctx, tx, *t, "messages.withdrawn", "device", t.NodeID, map[string]any{"count": tag.RowsAffected(), "reason": r.Reason}); err != nil {
				return err
			}
		}
		return setThreadStatus(ctx, tx, t, "stopped", r.Reason)
	case "message.queued", "message.sent", "message.withdrawn", "message.unknown":
		m, err := reportThreadMessage(ctx, tx, *t, r.ClientMessageID)
		if err != nil {
			return err
		}
		next := strings.TrimPrefix(r.Kind, "message.")
		valid := m.Status == next || (m.Status == "accepted" && next == "queued") || ((m.Status == "accepted" || m.Status == "queued" || m.Status == "unknown") && (next == "sent" || next == "unknown")) || ((m.Status == "accepted" || m.Status == "queued") && next == "withdrawn")
		if !valid {
			return threadConflict()
		}
		var turnID any
		var turnSeq any
		if next == "sent" {
			turn, err := reportThreadTurn(ctx, tx, *t, r.WorkerTurnSeq)
			if err != nil {
				return err
			}
			if turn.EndedAt != nil {
				return threadConflict()
			}
			if m.WorkerTurnSeq != nil && *m.WorkerTurnSeq != r.WorkerTurnSeq {
				return threadConflict()
			}
			turnID = turn.ID
			turnSeq = turn.WorkerTurnSeq
		}
		_, err = tx.Exec(ctx, `UPDATE thread_messages SET status=$4,turn_id=COALESCE($5::uuid,turn_id),worker_turn_seq=COALESCE($6::bigint,worker_turn_seq),status_reason=$7 WHERE employee_id=$1 AND thread_id=$2 AND client_message_id=$3`, t.EmployeeID, t.ID, r.ClientMessageID, next, turnID, turnSeq, r.Reason)
		if err != nil {
			return err
		}
		if next == "unknown" {
			return setThreadStatus(ctx, tx, t, "unknown", r.Reason)
		}
		if next == "withdrawn" && r.Reason != "" {
			if err := noActiveThreadTurn(ctx, tx, t.ID); err != nil {
				return err
			}
			if m.Status != "withdrawn" && m.Sender == "project_agent" {
				payload := map[string]any{"thread_id": t.ID, "client_message_id": m.ClientMessageID, "origin_tool_call_id": m.OriginToolCallID, "reason": r.Reason}
				if err := insertThreadProjectInput(ctx, tx, *t, "thread_message_failed", fmt.Sprintf("thread:%s:message:%s:failed", t.ID, m.ID), payload, 40<<10); err != nil {
					return err
				}
			}
			return setThreadStatus(ctx, tx, t, "idle", "")
		}
		return nil
	case "turn.started":
		if t.OpenedAt == nil || (t.Status != "idle" && t.Status != "stopped" && t.Status != "unknown" && t.Status != "running") {
			return threadConflict()
		}
		if err := noActiveThreadTurn(ctx, tx, t.ID); err != nil {
			return err
		}
		m, err := reportThreadMessage(ctx, tx, *t, r.ClientMessageID)
		if err != nil {
			return err
		}
		if m.Status == "sent" || m.Status == "withdrawn" || m.WorkerTurnSeq != nil {
			return threadConflict()
		}
		var expected int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(max(worker_turn_seq),0)+1 FROM thread_turns WHERE thread_id=$1`, t.ID).Scan(&expected); err != nil {
			return err
		}
		if r.WorkerTurnSeq != expected || (t.AgentType == "shell" && expected != 1) {
			return threadConflict()
		}
		id, err := identity.NewUUID()
		if err != nil {
			return err
		}
		model := r.Model
		if model == "" {
			model = m.Model
		}
		if model == "" {
			model = t.Model
		}
		_, err = tx.Exec(ctx, `INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,origin_tool_call_id,started_at,model) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7)`, id, t.EmployeeID, t.ID, r.WorkerTurnSeq, m.Sender, nullableProjectID(m.OriginToolCallID), model)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE thread_messages SET turn_id=$3,worker_turn_seq=$4 WHERE employee_id=$1 AND id=$2`, t.EmployeeID, m.ID, id, r.WorkerTurnSeq)
		if err != nil {
			return err
		}
		if err = setThreadModel(ctx, tx, t, model); err != nil {
			return err
		}
		return setThreadStatus(ctx, tx, t, "running", "")
	case "reply", "turn.ended":
		turn, err := reportThreadTurn(ctx, tx, *t, r.WorkerTurnSeq)
		if err != nil {
			return err
		}
		if turn.EndedAt != nil {
			return threadConflict()
		}
		if r.Kind == "reply" {
			return saveThreadReply(ctx, tx, *t, turn, r)
		}
		if !threadEndReasons[r.Reason] {
			return threadInvalid()
		}
		if r.Model != "" {
			turn.Model = r.Model
		}
		_, err = tx.Exec(ctx, `UPDATE thread_turns SET ended_at=clock_timestamp(),end_reason=$2,model=$3 WHERE id=$1`, turn.ID, r.Reason, turn.Model)
		if err != nil {
			return err
		}
		if err = setThreadModel(ctx, tx, t, turn.Model); err != nil {
			return err
		}
		if t.StopRequestedAt != nil && (r.Reason == "stopped" || r.Reason == "timeout") {
			if _, err = tx.Exec(ctx, `UPDATE threads SET stop_confirmed_at=clock_timestamp() WHERE id=$1`, t.ID); err != nil {
				return err
			}
		}
		if err = enqueueThreadTurnEnded(ctx, tx, *t, turn, r.Reason); err != nil {
			return err
		}
		status := "running"
		if r.QueueEmpty {
			status = "idle"
		}
		if t.AgentType == "shell" {
			status = "stopped"
		}
		return setThreadStatus(ctx, tx, t, status, "")
	case "thread.stopped", "thread.unknown":
		if r.HistoryUnavailable {
			if err := endThreadTurnAfterHistoryLoss(ctx, tx, *t); err != nil {
				return err
			}
		} else if err := noActiveThreadTurn(ctx, tx, t.ID); err != nil {
			return err
		}
		if r.Kind == "thread.stopped" && t.StopRequestedAt != nil {
			if _, err := tx.Exec(ctx, `UPDATE threads SET stop_confirmed_at=clock_timestamp() WHERE id=$1`, t.ID); err != nil {
				return err
			}
		}
		return setThreadStatus(ctx, tx, t, strings.TrimPrefix(r.Kind, "thread."), r.Reason)
	}
	return threadInvalid()
}

func saveThreadReply(ctx context.Context, tx pgx.Tx, t Thread, turn ThreadTurn, r *protocol.ThreadReport) error {
	if len(r.Attachments) == 0 {
		r.Attachments = json.RawMessage(`[]`)
	}
	if len(r.Metadata) == 0 {
		r.Metadata = json.RawMessage(`{}`)
	}
	var valid bool
	if !json.Valid(r.Attachments) || !json.Valid(r.Metadata) {
		return threadInvalid()
	}
	var meta struct {
		Encoding string `json:"encoding"`
	}
	_ = json.Unmarshal(r.Metadata, &meta)
	if meta.Encoding == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(r.Content)
		if err != nil || len(decoded) > 32<<10 {
			return threadInvalid()
		}
		if r.OriginalBytes < int64(len(decoded)) {
			r.OriginalBytes = int64(len(decoded))
		}
		r.Truncated = r.Truncated || r.OriginalBytes > int64(len(decoded))
	} else {
		original := int64(len(r.Content))
		if r.OriginalBytes < original {
			r.OriginalBytes = original
		}
		r.Content = boundedText(r.Content, 32<<10)
		r.Truncated = r.Truncated || r.OriginalBytes > int64(len(r.Content))
	}
	err := tx.QueryRow(ctx, `SELECT jsonb_typeof($1::jsonb)='array' AND octet_length($1::jsonb::text)<=4096 AND jsonb_typeof($2::jsonb)='object' AND octet_length($2::jsonb::text)<=4096`, r.Attachments, r.Metadata).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return threadInvalid()
	}
	id, err := identity.NewUUID()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO thread_replies(id,employee_id,thread_id,worker_seq,turn_id,worker_turn_seq,content,truncated,original_bytes,attachments,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, id, t.EmployeeID, t.ID, r.WorkerSeq, turn.ID, turn.WorkerTurnSeq, r.Content, r.Truncated, r.OriginalBytes, r.Attachments, r.Metadata)
	if err != nil {
		return err
	}
	if turn.Initiator != "project_agent" {
		return nil
	}
	payload := map[string]any{"thread_id": t.ID, "worker_turn_seq": turn.WorkerTurnSeq, "model": turn.Model, "worker_seq": r.WorkerSeq, "content": r.Content, "truncated": r.Truncated, "original_bytes": r.OriginalBytes, "attachments": r.Attachments, "full_content": "完整内容用 threads.read 读取"}
	return insertThreadProjectInput(ctx, tx, t, "thread_reply", fmt.Sprintf("thread:%s:reply:%d", t.ID, r.WorkerSeq), payload, 40<<10)
}
func enqueueThreadTurnEnded(ctx context.Context, tx pgx.Tx, t Thread, turn ThreadTurn, reason string) error {
	if turn.Initiator != "project_agent" {
		return nil
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM thread_replies WHERE thread_id=$1 AND turn_id=$2`, t.ID, turn.ID).Scan(&count); err != nil {
		return err
	}
	payload := map[string]any{"thread_id": t.ID, "worker_turn_seq": turn.WorkerTurnSeq, "model": turn.Model, "reason": reason, "reply_count": count}
	limit := 4 << 10
	if t.AgentType == "shell" {
		command, err := shellThreadCommandResult(ctx, tx, t.EmployeeID, t.ID)
		if err != nil {
			return err
		}
		payload["command_result"] = command
		payload["read_tool"] = "threads.read"
		limit = 72 << 10
	}
	return insertThreadProjectInput(ctx, tx, t, "turn_ended", fmt.Sprintf("thread:%s:turn:%d", t.ID, turn.WorkerTurnSeq), payload, limit)
}
func insertThreadProjectInput(ctx context.Context, tx pgx.Tx, t Thread, kind, key string, payload map[string]any, maxBytes int) error {
	var agentID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM project_agents WHERE employee_id=$1 AND project_id=$2`, t.EmployeeID, t.ProjectID).Scan(&agentID); err != nil {
		return err
	}
	// JSON 转义和 jsonb 排版也占容量，必要时进一步缩短正文。
	original, _ := payload["content"].(string)
	command, hasCommand := payload["command_result"].(map[string]any)
	if hasCommand {
		original, _ = command["output"].(string)
	}
	limit := len(original)
	for {
		raw, err := protocol.MarshalJSON(payload)
		if err != nil {
			return err
		}
		var fits bool
		if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)<=$2`, raw, maxBytes).Scan(&fits); err != nil {
			return err
		}
		if len(raw) <= maxBytes && fits {
			return insertProjectInput(ctx, tx, t.EmployeeID, agentID, kind, key, payload)
		}
		if limit == 0 {
			return threadInvalid()
		}
		limit = max(0, limit-1024)
		if hasCommand {
			if command["encoding"] == "base64" {
				limit = limit / 8 * 8
			}
			command["output"] = boundedText(original, limit)
			command["truncated"] = true
		} else {
			payload["content"] = boundedText(original, limit)
			payload["truncated"] = true
		}
	}
}
func finishThreadArchive(ctx context.Context, tx pgx.Tx, t *Thread) error {
	var ready bool
	err := tx.QueryRow(ctx, `SELECT archive_requested_at IS NOT NULL AND stop_confirmed_at IS NOT NULL AND status IN ('idle','stopped')
 AND NOT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM thread_messages WHERE thread_id=$1 AND status IN ('accepted','queued')) FROM threads WHERE id=$1`, t.ID).Scan(&ready)
	if err != nil || !ready {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE threads SET status='archived',archived_at=clock_timestamp() WHERE id=$1`, t.ID); err != nil {
		return err
	}
	t.Status = "archived"
	actor, actorID := "employee", t.EmployeeID
	err = tx.QueryRow(ctx, `SELECT actor,actor_id FROM thread_events WHERE thread_id=$1 AND kind='archive.requested' ORDER BY id DESC LIMIT 1`, t.ID).Scan(&actor, &actorID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return threadAudit(ctx, tx, *t, "thread.archived", actor, actorID, map[string]any{})
}

package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"baton/internal/projectagent"
	"github.com/jackc/pgx/v5"
)

func projectThreadInput(b projectRunBinding, callID, nodeID, agentType, directory, message string, timeout int) CreateThreadInput {
	key := fmt.Sprintf("pa:%s:%s", b.conversationID, callID)
	return CreateThreadInput{ClientThreadID: key, NodeID: nodeID, AgentType: agentType, WorkingDirectory: directory,
		ProjectID: b.projectID, ExecutionTimeoutSeconds: timeout, CreatedBy: "project_agent",
		OriginConversationID: b.conversationID, OriginToolCallID: callID,
		Message: ThreadMessageInput{ClientMessageID: key + ":0", Content: message, Sender: "project_agent", OriginToolCallID: callID}}
}

func projectThreadResult(t Thread) map[string]any {
	return map[string]any{"thread_id": t.ID, "status": t.Status, "version": t.Version, "read_tool": "threads.get"}
}

func projectThread(ctx context.Context, tx pgx.Tx, b projectRunBinding, id string, lock bool) (Thread, error) {
	if id == "" {
		return Thread{}, projectagent.ErrInvalid
	}
	t, err := readThread(ctx, tx, b.owner, id, lock)
	if err == nil && t.ProjectID != b.projectID {
		err = ErrNotFound
	}
	return t, err
}

func (s *Store) executeProjectThreadTool(ctx context.Context, tx pgx.Tx, b projectRunBinding, callID, name string, a toolArguments) (any, error) {
	switch name {
	case "threads.create":
		if a.NodeID == "" || a.AgentType == "shell" || strings.TrimSpace(a.Message) == "" {
			return nil, projectagent.ErrInvalid
		}
		timeout := 7200
		if a.ExecutionTimeoutSeconds != nil {
			timeout = *a.ExecutionTimeoutSeconds
			if timeout < 1 {
				return nil, projectagent.ErrInvalid
			}
		}
		t, _, err := createThreadTx(ctx, tx, b.owner, projectThreadInput(b, callID, a.NodeID, a.AgentType, a.WorkingDirectory, a.Message, timeout))
		if err != nil {
			return nil, err
		}
		return projectThreadResult(t), nil
	case "threads.list":
		if a.Status != "" && !threadStatus(a.Status) {
			return nil, projectagent.ErrInvalid
		}
		rows, err := tx.Query(ctx, `SELECT `+threadJSON+` FROM threads t LEFT JOIN node_presence p ON p.node_id=t.node_id
   WHERE t.employee_id=$1 AND t.project_id=$2 AND ($3='' OR t.status=$3) AND ($4::uuid IS NULL OR t.id>$4) ORDER BY t.id LIMIT 20`, b.owner, b.projectID, a.Status, nullableProjectID(a.AfterID))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []Thread{}
		last := ""
		for rows.Next() {
			var raw []byte
			var t Thread
			if err = rows.Scan(&raw); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(raw, &t); err != nil {
				return nil, err
			}
			items = append(items, t)
			last = t.ID
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return toolJSONPage(map[string]any{"threads": items, "next_after_id": last}, a)
	}
	t, err := projectThread(ctx, tx, b, a.ThreadID, name == "threads.send" || name == "threads.stop" || name == "threads.archive")
	if err != nil {
		return nil, err
	}
	switch name {
	case "threads.send":
		in := ThreadMessageInput{ClientMessageID: fmt.Sprintf("pa:%s:%s", b.conversationID, callID), Content: a.Message, Mode: a.Mode, Sender: "project_agent", OriginToolCallID: callID}
		if err = normalizeThreadMessage(&in); err != nil {
			return nil, err
		}
		if _, _, err = insertThreadMessage(ctx, tx, t, in); err != nil {
			return nil, err
		}
		t, err = readThread(ctx, tx, b.owner, t.ID, false)
		if err != nil {
			return nil, err
		}
		out := projectThreadResult(t)
		out["client_message_id"] = in.ClientMessageID
		return out, nil
	case "threads.stop", "threads.archive":
		t, err = requestThreadActionTx(ctx, tx, b.owner, t.ID, strings.TrimPrefix(name, "threads."), "", "project_agent", b.agentID)
		if err != nil {
			return nil, err
		}
		return projectThreadResult(t), nil
	case "threads.get":
		view, err := threadDetailTx(ctx, tx, b.owner, t.ID)
		if err != nil {
			return nil, err
		}
		return toolJSONPage(view, a)
	case "threads.read":
		through := a.ThroughTurn
		if through == 0 {
			if err = tx.QueryRow(ctx, `SELECT COALESCE(max(worker_turn_seq),0) FROM thread_turns WHERE thread_id=$1`, t.ID).Scan(&through); err != nil {
				return nil, err
			}
		}
		if through < a.AfterTurn {
			return nil, projectagent.ErrInvalid
		}
		rows, err := tx.Query(ctx, `SELECT to_jsonb(v) || jsonb_build_object(
   'messages',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at,m.id) FROM thread_messages m WHERE m.thread_id=v.thread_id AND m.worker_turn_seq=v.worker_turn_seq),'[]'::jsonb),
   'replies',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.worker_seq) FROM thread_replies r WHERE r.thread_id=v.thread_id AND r.worker_turn_seq=v.worker_turn_seq),'[]'::jsonb))
   FROM thread_turns v WHERE v.employee_id=$1 AND v.thread_id=$2 AND v.worker_turn_seq>$3 AND v.worker_turn_seq<=$4 ORDER BY v.worker_turn_seq LIMIT 20`, b.owner, t.ID, a.AfterTurn, through)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		turns := []json.RawMessage{}
		last := a.AfterTurn
		for rows.Next() {
			var raw json.RawMessage
			if err = rows.Scan(&raw); err != nil {
				return nil, err
			}
			var turn ThreadTurn
			if err = json.Unmarshal(raw, &turn); err != nil {
				return nil, err
			}
			last = turn.WorkerTurnSeq
			turns = append(turns, raw)
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return toolJSONPage(map[string]any{"turns": turns, "next_after_turn": last, "through_turn": through}, a)
	}
	return nil, projectagent.ErrInvalid
}

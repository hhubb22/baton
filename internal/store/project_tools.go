package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/task"
	"github.com/jackc/pgx/v5"
)

const maxProjectToolBytes = 32 << 10

type savedToolCall struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type toolArguments struct {
	Summary                 string         `json:"summary"`
	Options                 []inbox.Option `json:"options"`
	AllowText               bool           `json:"allow_text"`
	RequestID               string         `json:"request_id"`
	Reason                  string         `json:"reason"`
	EntryID                 string         `json:"entry_id"`
	Title                   string         `json:"title"`
	Content                 string         `json:"content"`
	ExpectedRevision        int64          `json:"expected_revision"`
	Revision                int64          `json:"revision"`
	Query                   string         `json:"query"`
	AfterID                 string         `json:"after_id"`
	AfterSeq                int64          `json:"after_seq"`
	ThroughSeq              int64          `json:"through_seq"`
	TaskID                  string         `json:"task_id"`
	Status                  string         `json:"status"`
	Version                 int            `json:"version"`
	TargetNodeID            string         `json:"target_node_id"`
	AgentType               string         `json:"agent_type"`
	WorkingDirectory        string         `json:"working_directory"`
	Description             string         `json:"description"`
	ExpectedOutputs         string         `json:"expected_outputs"`
	QueueTimeoutSeconds     *int           `json:"queue_timeout_seconds"`
	ExecutionTimeoutSeconds *int           `json:"execution_timeout_seconds"`
	RetryOfTaskID           string         `json:"retry_of_task_id"`
	Offset                  int            `json:"offset"`
	MaxBytes                int            `json:"max_bytes"`
}

var projectToolFields = map[string]string{
	"inbox.ask":      "title summary content options allow_text task_id",
	"inbox.list":     "after_id offset max_bytes",
	"inbox.get":      "request_id offset max_bytes",
	"inbox.withdraw": "request_id reason",
	"memory.search":  "query after_id offset max_bytes",
	"memory.read":    "entry_id revision offset max_bytes",
	"memory.write":   "entry_id title content expected_revision",
	"history.search": "query after_seq through_seq offset max_bytes",
	"history.read":   "after_seq through_seq offset max_bytes",
	"devices.list":   "after_id offset max_bytes",
	"tasks.dispatch": "target_node_id agent_type working_directory description expected_outputs queue_timeout_seconds execution_timeout_seconds retry_of_task_id",
	"tasks.list":     "status after_id offset max_bytes",
	"tasks.get":      "task_id version offset max_bytes",
	"tasks.cancel":   "task_id",
}

func decodeToolArguments(name string, raw json.RawMessage) (toolArguments, error) {
	var a toolArguments
	fields, ok := projectToolFields[name]
	if !ok {
		return a, projectagent.ErrInvalid
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return a, projectagent.ErrInvalid
	}
	for key := range object {
		if !strings.Contains(" "+fields+" ", " "+key+" ") {
			return a, projectagent.ErrInvalid
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&a) != nil || d.Decode(new(any)) != io.EOF {
		return a, projectagent.ErrInvalid
	}
	if a.Offset < 0 || a.MaxBytes < 0 || a.MaxBytes > maxProjectToolBytes || a.Revision < 0 || a.AfterSeq < 0 || a.ThroughSeq < 0 || a.Version < 0 {
		return a, projectagent.ErrInvalid
	}
	for _, id := range []string{a.EntryID, a.TaskID, a.AfterID, a.TargetNodeID, a.RetryOfTaskID, a.RequestID} {
		if id != "" {
			if _, err := identity.ParseUUID(id); err != nil {
				return a, projectagent.ErrInvalid
			}
		}
	}
	if !utf8.Valid(raw) || strings.ContainsRune(a.Query, 0) {
		return a, projectagent.ErrInvalid
	}
	return a, nil
}

// callProjectTool 把工具业务和唯一结果写入同一事务；保存点用于撤销被拒绝的业务变更。
func (s *Store) callProjectTool(ctx context.Context, tx pgx.Tx, b projectRunBinding, req protocol.ProjectRuntimeRequest) (projectagent.Event, error) {
	var empty projectagent.Event
	if req.ToolCallID == "" || len(req.ToolCallID) > 128 || len(req.ToolName) > 128 {
		return empty, projectagent.ErrInvalid
	}
	if err := tx.QueryRow(ctx, `SELECT next_seq FROM conversations WHERE id=$1 FOR UPDATE`, b.conversationID).Scan(&b.nextSeq); err != nil {
		return empty, err
	}
	old, err := scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND kind='tool_result' AND tool_call_id=$2`, b.conversationID, req.ToolCallID))
	if err == nil {
		return old, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	if req.LastSeq != b.nextSeq-1 {
		return empty, projectagent.ErrConflict
	}
	var payload struct {
		Message struct {
			Content []savedToolCall `json:"content"`
		} `json:"message"`
	}
	var raw []byte
	var assistantSeq int64
	err = tx.QueryRow(ctx, `SELECT seq,payload FROM conversation_events WHERE conversation_id=$1 AND kind='assistant' ORDER BY seq DESC LIMIT 1`, b.conversationID).Scan(&assistantSeq, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, projectagent.ErrInvalid
	}
	if err != nil {
		return empty, err
	}
	if json.Unmarshal(raw, &payload) != nil {
		return empty, projectagent.ErrInvalid
	}
	var call *savedToolCall
	seen := map[string]bool{}
	for i := range payload.Message.Content {
		c := &payload.Message.Content[i]
		if c.Type != "toolCall" {
			continue
		}
		if c.ID == "" || seen[c.ID] {
			return empty, projectagent.ErrInvalid
		}
		seen[c.ID] = true
		if c.ID == req.ToolCallID {
			call = c
			break
		}
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND tool_call_id=$2 AND kind='tool_result')`, b.conversationID, c.ID).Scan(&exists); err != nil {
			return empty, err
		}
		if !exists {
			return empty, projectagent.ErrConflict
		}
	}
	if call == nil {
		return empty, projectagent.ErrInvalid
	}
	if req.ToolName != call.Name || !json.Valid(req.Arguments) || !json.Valid(call.Arguments) {
		return empty, projectagent.ErrInvalid
	}
	var equal bool
	if err = tx.QueryRow(ctx, `SELECT $1::jsonb=$2::jsonb`, req.Arguments, call.Arguments).Scan(&equal); err != nil {
		return empty, projectagent.ErrInvalid
	}
	if !equal {
		return empty, projectagent.ErrConflict
	}
	// 只有该 assistant 之后的工具结果可以接续；不能跨过新输入或压缩继续执行旧调用。
	var intervening bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND seq>$2 AND kind<>'tool_result')`, b.conversationID, assistantSeq).Scan(&intervening); err != nil {
		return empty, err
	}
	if intervening {
		return empty, projectagent.ErrConflict
	}
	business, err := tx.Begin(ctx)
	if err != nil {
		return empty, err
	}
	a, businessErr := decodeToolArguments(call.Name, call.Arguments)
	var output any
	if businessErr == nil {
		output, businessErr = s.executeProjectTool(ctx, business, b, assistantSeq, call.ID, call.Name, a)
	}
	isError := businessErr != nil
	if businessErr != nil {
		if err = business.Rollback(ctx); err != nil {
			return empty, err
		}
		var rejection *task.Rejection
		var conflict *projectagent.MemoryConflict
		switch {
		case errors.As(businessErr, &conflict):
			output = map[string]any{"error": conflict.Error(), "current": conflict.Current, "read_tool": "memory.read", "entry_id": a.EntryID}
			raw, _ := protocol.MarshalJSON(output)
			if len(raw) > 12<<10 {
				var revision int64
				if conflict.Current != nil {
					revision = conflict.Current.Revision
				}
				output = map[string]any{"error": conflict.Error(), "current_revision": revision, "entry_id": a.EntryID, "read_tool": "memory.read", "truncated": true}
			}
		case errors.As(businessErr, &rejection):
			output = map[string]any{"error": rejection.Message, "code": rejection.Code}
		case errors.Is(businessErr, inbox.ErrInvalid), errors.Is(businessErr, inbox.ErrNotFound), errors.Is(businessErr, inbox.ErrLimit):
			output = map[string]any{"error": businessErr.Error()}
		case errors.Is(businessErr, projectagent.ErrInvalid), errors.Is(businessErr, projectagent.ErrTooLarge), errors.Is(businessErr, projectagent.ErrConflict), errors.Is(businessErr, ErrNotFound), errors.Is(businessErr, ErrNotVisible):
			output = map[string]any{"error": "工具名称、参数、资源归属或版本无效"}
		default:
			return empty, businessErr
		}
	} else if err = business.Commit(ctx); err != nil {
		return empty, err
	}
	text, err := protocol.MarshalJSON(output)
	if err != nil {
		return empty, err
	}
	if len(text) > 12<<10 {
		return empty, projectagent.ErrTooLarge
	}
	result := map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "toolResult", "toolCallId": call.ID, "toolName": call.Name, "content": []any{map[string]any{"type": "text", "text": string(text)}}, "isError": isError, "timestamp": 0}}
	encoded, err := protocol.MarshalJSON(result)
	if len(encoded) > maxProjectToolBytes {
		return empty, projectagent.ErrTooLarge
	}
	if err != nil {
		return empty, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,tool_call_id,run_id,lease_epoch,payload) VALUES($1,$2,$3,'tool_result',$4,$5,$6,$7)`, b.conversationID, b.nextSeq, b.owner, call.ID, req.RunID, req.LeaseEpoch, encoded); err != nil {
		return empty, err
	}
	if _, err = tx.Exec(ctx, `UPDATE conversations SET next_seq=next_seq+1 WHERE id=$1`, b.conversationID); err != nil {
		return empty, err
	}
	if err = s.runBeforeCommit(ctx); err != nil {
		return empty, err
	}
	return scanProjectEvent(tx.QueryRow(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq=$2`, b.conversationID, b.nextSeq))
}

// toolJSONPage 用编码后的输出计量容量，偏移总是停在 UTF-8 边界。
func toolJSONPage(value any, a toolArguments) (any, error) {
	raw, err := protocol.MarshalJSON(value)
	if err != nil {
		return nil, err
	}
	if a.Offset > len(raw) || (a.Offset < len(raw) && !utf8.RuneStart(raw[a.Offset])) {
		return nil, projectagent.ErrInvalid
	}
	size := a.MaxBytes
	if size == 0 {
		size = 16 << 10
	}
	end := min(len(raw), a.Offset+size)
	for end < len(raw) && end > a.Offset && !utf8.RuneStart(raw[end]) {
		end--
	}
	for {
		out := map[string]any{"encoding": "json", "text": string(raw[a.Offset:end]), "offset": a.Offset, "total_bytes": len(raw), "truncated": end < len(raw)}
		if end < len(raw) {
			out["next_offset"] = end
		}
		encoded, _ := protocol.MarshalJSON(out)
		if len(encoded) <= 12<<10 {
			if end == a.Offset && end < len(raw) {
				return nil, projectagent.ErrInvalid
			}
			return out, nil
		}
		end = a.Offset + (end-a.Offset)*3/4
		for end > a.Offset && !utf8.RuneStart(raw[end]) {
			end--
		}
	}
}

func (s *Store) executeProjectTool(ctx context.Context, tx pgx.Tx, b projectRunBinding, sourceSeq int64, callID string, name string, a toolArguments) (any, error) {
	switch name {
	case "inbox.ask", "inbox.get", "inbox.list", "inbox.withdraw":
		return s.executeInboxTool(ctx, tx, b, callID, name, a)
	case "memory.write":
		if a.EntryID == "" {
			if a.ExpectedRevision != 0 {
				return nil, projectagent.ErrInvalid
			}
			var err error
			a.EntryID, err = identity.NewUUID()
			if err != nil {
				return nil, err
			}
		}
		p := projectagent.Project{}
		p.Agent.ID = b.agentID
		p.Conversation.ID = b.conversationID
		m, err := writeProjectMemoryTx(ctx, tx, b.owner, b.projectID, a.EntryID, p, projectagent.MemoryWrite{Title: a.Title, Content: a.Content, ExpectedRevision: a.ExpectedRevision, Author: "agent", SourceSeq: &sourceSeq})
		if err != nil {
			return nil, err
		}
		return map[string]any{"entry_id": m.ID, "revision": m.Revision, "read_tool": "memory.read"}, nil
	case "memory.read":
		if a.EntryID == "" {
			return nil, projectagent.ErrInvalid
		}
		query := memorySelect + ` WHERE e.employee_id=$1 AND e.project_id=$2 AND e.id=$3`
		if a.Revision > 0 {
			query = `SELECT e.id::text,e.title,r.content,r.revision,r.author,r.source_seq,e.updated_at FROM project_memory_entries e JOIN project_memory_revisions r ON r.employee_id=e.employee_id AND r.entry_id=e.id WHERE e.employee_id=$1 AND e.project_id=$2 AND e.id=$3 AND r.revision=$4`
		}
		args := []any{b.owner, b.projectID, a.EntryID}
		if a.Revision > 0 {
			args = append(args, a.Revision)
		}
		m, err := scanMemory(tx.QueryRow(ctx, query, args...))
		if err != nil {
			return nil, err
		}
		return toolJSONPage(m, a)
	case "memory.search":
		rows, err := tx.Query(ctx, memorySelect+` WHERE e.employee_id=$1 AND e.project_id=$2 AND (strpos(lower(e.title),lower($3))>0 OR strpos(lower(r.content),lower($3))>0) AND ($4::uuid IS NULL OR e.id>$4) ORDER BY e.id LIMIT 20`, b.owner, b.projectID, a.Query, nullableProjectID(a.AfterID))
		if err != nil {
			return nil, err
		}
		items := []any{}
		last := ""
		for rows.Next() {
			m, err := scanMemory(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			items = append(items, map[string]any{"entry_id": m.ID, "title": m.Title, "revision": m.Revision, "snippet": boundedText(m.Content, 512)})
			last = m.ID
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		return toolJSONPage(map[string]any{"entries": items, "next_after_id": last}, a)
	case "history.search", "history.read":
		through := a.ThroughSeq
		if through == 0 {
			through = sourceSeq
		}
		if through > sourceSeq || through < a.AfterSeq {
			return nil, projectagent.ErrInvalid
		}
		filter := ""
		args := []any{b.conversationID, a.AfterSeq, through}
		if name == "history.search" {
			filter = ` AND strpos(lower(payload::text),lower($4))>0`
			args = append(args, a.Query)
		}
		rows, err := tx.Query(ctx, projectEventSelect+` WHERE conversation_id=$1 AND seq>$2 AND seq<=$3`+filter+` ORDER BY seq LIMIT 20`, args...)
		if err != nil {
			return nil, err
		}
		items := []any{}
		last := a.AfterSeq
		for rows.Next() {
			e, err := scanProjectEvent(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			last = e.Seq
			if name == "history.search" {
				items = append(items, map[string]any{"seq": e.Seq, "kind": e.Kind, "snippet": boundedText(string(e.Payload), 512)})
			} else {
				items = append(items, e)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		return toolJSONPage(map[string]any{"events": items, "next_after_seq": last, "through_seq": through}, a)
	case "devices.list":
		rows, err := tx.Query(ctx, `SELECT n.id::text,n.display_name,n.capabilities,COALESCE(p.online AND p.synced,false),r.report,r.report_version,r.reported_at FROM nodes n LEFT JOIN node_presence p ON p.node_id=n.id LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.employee_id=$1 AND n.revoked_at IS NULL AND ($2::uuid IS NULL OR n.id>$2) ORDER BY n.id LIMIT 20`, b.owner, nullableProjectID(a.AfterID))
		if err != nil {
			return nil, err
		}
		items := []any{}
		last := ""
		for rows.Next() {
			var id, title string
			var caps []string
			var online bool
			var report json.RawMessage
			var version *int64
			var at any
			if err = rows.Scan(&id, &title, &caps, &online, &report, &version, &at); err != nil {
				rows.Close()
				return nil, err
			}
			last = id
			items = append(items, map[string]any{"node_id": id, "name": title, "capabilities": caps, "online": online, "report": report, "report_version": version, "reported_at": at})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		return toolJSONPage(map[string]any{"devices": items, "next_after_id": last}, a)
	case "tasks.dispatch":
		return s.dispatchProjectTask(ctx, tx, b, callID, a)
	case "tasks.get", "tasks.cancel":
		if a.TaskID == "" {
			return nil, projectagent.ErrInvalid
		}
		suffix := ""
		if name == "tasks.cancel" {
			suffix = " FOR UPDATE"
		}
		rec, _, found, err := loadTask(ctx, tx, ` WHERE employee_id=$1 AND project_id=$2 AND id=$3`+suffix, b.owner, b.projectID, a.TaskID)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, ErrNotFound
		}
		if name == "tasks.cancel" {
			if _, err = s.cancelTree(ctx, tx, b.owner, a.TaskID, false); err != nil {
				return nil, err
			}
			return map[string]any{"task_id": a.TaskID, "read_tool": "tasks.get"}, nil
		}
		if a.Version != 0 && a.Version != rec.Version {
			return nil, projectagent.ErrConflict
		}
		loaded := []task.Record{rec}
		if err = attachResults(ctx, tx, b.owner, loaded); err != nil {
			return nil, err
		}
		return toolJSONPage(loaded[0], a)
	case "tasks.list":
		switch a.Status {
		case "", task.StatusQueued, task.StatusRunning, task.StatusNeedsVerification, task.StatusCompleted, task.StatusFailed, task.StatusCancelled:
		default:
			return nil, projectagent.ErrInvalid
		}
		rows, err := tx.Query(ctx, `SELECT id::text,status,version,description FROM tasks WHERE employee_id=$1 AND project_id=$2 AND ($3='' OR status=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 20`, b.owner, b.projectID, a.Status, nullableProjectID(a.AfterID))
		if err != nil {
			return nil, err
		}
		items := []any{}
		last := ""
		for rows.Next() {
			var id, status, desc string
			var version int
			if err = rows.Scan(&id, &status, &version, &desc); err != nil {
				rows.Close()
				return nil, err
			}
			last = id
			items = append(items, map[string]any{"task_id": id, "status": status, "version": version, "description": boundedText(desc, 512)})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		return toolJSONPage(map[string]any{"tasks": items, "next_after_id": last}, a)
	}
	return nil, projectagent.ErrInvalid
}

func (s *Store) dispatchProjectTask(ctx context.Context, tx pgx.Tx, b projectRunBinding, callID string, a toolArguments) (any, error) {
	if a.TargetNodeID == "" || a.AgentType == "" || a.AgentType == "shell" || a.WorkingDirectory == "" || a.Description == "" || a.ExpectedOutputs == "" {
		return nil, projectagent.ErrInvalid
	}
	if a.RetryOfTaskID != "" {
		var status string
		err := tx.QueryRow(ctx, `SELECT status FROM tasks WHERE employee_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE`, b.owner, b.projectID, a.RetryOfTaskID).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if status != task.StatusFailed && status != task.StatusCancelled {
			return nil, projectagent.ErrConflict
		}
	}
	input := task.Input{RequestID: fmt.Sprintf("pa:%s:%s", b.conversationID, callID), TargetNodeID: &a.TargetNodeID, AgentType: &a.AgentType, WorkingDirectory: &a.WorkingDirectory, Description: a.Description, ExpectedOutputs: &a.ExpectedOutputs, QueueTimeoutSeconds: a.QueueTimeoutSeconds, ExecutionTimeoutSeconds: a.ExecutionTimeoutSeconds}
	if err := task.Validate(input); err != nil {
		return nil, err
	}
	prepared, err := task.Prepare(input)
	if err != nil {
		return nil, err
	}
	rec, _, err := s.acceptOnceTx(ctx, tx, b.owner, prepared, nil)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE tasks SET project_id=$2,origin_conversation_id=$3,origin_tool_call_id=$4 WHERE id=$1`, rec.TaskID, b.projectID, b.conversationID, callID); err != nil {
		return nil, err
	}
	if a.RetryOfTaskID != "" {
		if _, err = tx.Exec(ctx, `UPDATE task_relations SET rerun_of_task_id=$2 WHERE task_id=$1`, rec.TaskID, a.RetryOfTaskID); err != nil {
			return nil, err
		}
	}
	return map[string]any{"task_id": rec.TaskID, "status": rec.Status, "version": rec.Version, "read_tool": "tasks.get"}, nil
}

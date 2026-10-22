package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func threadText(s string, n int) bool {
	return len(s) > 0 && len(s) <= n && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}
func threadID(s string) bool { _, err := identity.ParseUUID(s); return err == nil }
func threadKey(s string) bool {
	return threadText(s, 256) && !strings.ContainsFunc(s, unicode.IsControl)
}
func threadModel(s string) bool {
	return s == "" || (threadText(s, 512) && !strings.ContainsFunc(s, unicode.IsControl))
}
func normalizeThreadMessage(in *ThreadMessageInput) error {
	if in.Mode == "" {
		in.Mode = "queue"
	}
	if in.Sender == "" {
		in.Sender = "employee"
	}
	if !threadKey(in.ClientMessageID) || !threadText(in.Content, 64<<10) || (in.Mode != "queue" && in.Mode != "steer") || (in.Sender != "employee" && in.Sender != "project_agent") {
		return threadInvalid()
	}
	if in.Sender == "project_agent" && !threadKey(in.OriginToolCallID) {
		return threadInvalid()
	}
	if !threadModel(in.Model) {
		return threadError(422, "model_invalid", "模型标识无效")
	}
	if in.Model != "" && in.Mode == "steer" {
		return threadError(422, "model_with_steer", "插入消息沿用当前一轮的模型，请用排队消息换模型")
	}
	// 存储代次最多 256 字节，按全部需要转义的情况为它预留传输容量。
	const frameID = "00000000-0000-4000-8000-000000000000"
	body, err := protocol.MarshalJSON(protocol.ThreadCommand{Type: protocol.BodyThreadCommand, ThreadID: frameID, Action: "message", StorageGeneration: strings.Repeat(`\`, 256), ClientMessageID: in.ClientMessageID, Content: in.Content, Mode: in.Mode, Model: in.Model})
	if err != nil {
		return err
	}
	envelope, err := protocol.MarshalJSON(protocol.Envelope{Version: protocol.Version, MessageID: frameID, Route: protocol.Route{To: frameID}, Priority: protocol.PriorityControl, Source: &protocol.Source{Kind: protocol.SourceControl}, Body: body})
	if err != nil {
		return err
	}
	frame, err := protocol.MarshalJSON(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: envelope})
	if err != nil {
		return err
	}
	if len(frame) > protocol.MaxMessageBytes {
		return threadError(413, "message_too_large", "消息的 JSON 编码超过设备传输上限")
	}
	return nil
}

// ThreadDirectoryAllowed 按目标系统的路径规则检查上报目录；设备仍须核实真实目录与链接。
func ThreadDirectoryAllowed(system, directory string, roots []protocol.RuntimeRoot) bool {
	windows := strings.Contains(strings.ToLower(system), "windows")
	normalize := func(s string) string {
		if windows {
			s = strings.ToLower(strings.ReplaceAll(s, `\`, "/"))
		}
		clean := path.Clean(s)
		if windows && len(s) >= 3 && s[1] == ':' && s[2] == '/' && len(clean) == 2 {
			return clean + "/"
		}
		return clean
	}
	d := normalize(directory)
	absolute := strings.HasPrefix(d, "/") || (windows && len(d) >= 3 && d[1] == ':' && d[2] == '/')
	if !absolute {
		return false
	}
	for _, r := range roots {
		root := normalize(r.Path)
		if d == root || strings.HasPrefix(d, strings.TrimRight(root, "/")+"/") {
			return true
		}
	}
	return false
}

func threadNode(ctx context.Context, tx pgx.Tx, employeeID, nodeID, agentType, directory string, steer bool, model *string, switchModel bool) error {
	var system string
	var reportRaw []byte
	err := tx.QueryRow(ctx, `SELECT n.system_name,COALESCE(r.report,'{}'::jsonb) FROM nodes n LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.id=$1::uuid AND n.employee_id=$2::uuid AND n.revoked_at IS NULL`, nodeID, employeeID).Scan(&system, &reportRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var report protocol.RuntimeReport
	if err = json.Unmarshal(reportRaw, &report); err != nil {
		return err
	}
	if !ThreadDirectoryAllowed(system, directory, report.Roots) {
		return threadError(422, "directory_not_allowed", "工作目录必须位于设备登记的目录内")
	}
	if agentType == "shell" {
		if *model != "" {
			return threadError(422, "model_unsupported", "命令 Thread 不使用模型")
		}
		if steer {
			return threadError(422, "steer_unsupported", "命令 Thread 不支持插入消息")
		}
		return projectExecEnabled(ctx, tx, employeeID, nodeID)
	}
	available := false
	canSteer := false
	canSwitch := false
	var models []protocol.RuntimeModel
	defaultModel := ""
	for _, a := range report.Agents {
		if a.AgentType == agentType && a.Status == "available" && a.Capabilities.Create {
			available = true
			canSteer = a.Capabilities.Steer
			canSwitch = a.Capabilities.SwitchModel
			models = a.Models
			defaultModel = a.DefaultModel
			break
		}
	}
	if !available {
		return threadError(422, "agent_unavailable", "设备未报告该 Agent 可用")
	}
	if steer && !canSteer {
		return threadError(422, "steer_unsupported", "设备的 Agent 不支持插入消息")
	}
	if *model != "" {
		found := false
		for _, candidate := range models {
			if candidate.ID == *model {
				found = true
				break
			}
		}
		if !found {
			return threadError(422, "model_unavailable", "设备未报告该模型可用")
		}
		if switchModel && !canSwitch {
			return threadError(422, "model_switch_unsupported", "设备的 Agent 不支持换模型")
		}
	} else if !switchModel {
		*model = defaultModel
	}
	return nil
}

func threadDefaultNode(ctx context.Context, tx pgx.Tx, employeeID string) (string, error) {
	_, err := tx.Exec(ctx, `INSERT INTO employee_settings(employee_id,updated_at) VALUES($1,now()) ON CONFLICT(employee_id) DO NOTHING`, employeeID)
	if err != nil {
		return "", err
	}
	var nodeID string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(default_device_node_id::text,'') FROM employee_settings WHERE employee_id=$1 FOR UPDATE`, employeeID).Scan(&nodeID); err != nil {
		return "", err
	}
	if nodeID != "" {
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM nodes WHERE id=$1 AND employee_id=$2 AND revoked_at IS NULL)`, nodeID, employeeID).Scan(&valid); err != nil {
			return "", err
		}
		if !valid {
			return "", threadError(422, "default_device_required", "请重新选择有效的默认设备")
		}
		return nodeID, nil
	}
	err = tx.QueryRow(ctx, `SELECT id::text FROM nodes WHERE employee_id=$1 AND revoked_at IS NULL ORDER BY registration_seq LIMIT 1`, employeeID).Scan(&nodeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", threadError(422, "default_device_required", "请先选择有效的默认设备")
	}
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `UPDATE employee_settings SET default_device_node_id=$2,updated_at=now() WHERE employee_id=$1`, employeeID, nodeID)
	return nodeID, err
}

// CreateThread 在同一事务保存 Thread、第一条消息及两条投递意图。
func (s *Store) CreateThread(ctx context.Context, employeeID string, in CreateThreadInput) (Thread, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Thread{}, false, err
	}
	defer tx.Rollback(ctx)
	t, created, err := createThreadTx(ctx, tx, employeeID, in)
	if err != nil {
		return t, false, err
	}
	return t, created, tx.Commit(ctx)
}

func createThreadTx(ctx context.Context, tx pgx.Tx, employeeID string, in CreateThreadInput) (Thread, bool, error) {
	var empty Thread
	if in.ExecutionTimeoutSeconds == 0 {
		in.ExecutionTimeoutSeconds = 7200
	}
	if in.CreatedBy == "" {
		in.CreatedBy = "employee"
	}
	in.Message.Sender = in.CreatedBy
	in.Message.OriginToolCallID = in.OriginToolCallID
	if !threadID(employeeID) || !threadKey(in.ClientThreadID) || !threadText(in.WorkingDirectory, 4096) || in.ExecutionTimeoutSeconds < 1 || in.ExecutionTimeoutSeconds > 2147483647 || (in.CreatedBy != "employee" && in.CreatedBy != "project_agent") || (in.NodeID != "" && !threadID(in.NodeID)) || (in.ProjectID != "" && !threadID(in.ProjectID)) {
		return empty, false, threadInvalid()
	}
	if in.AgentType != "pi" && in.AgentType != "codex" && in.AgentType != "kiro" && in.AgentType != "cursor" && !(in.AgentType == "shell" && in.CreatedBy == "project_agent") {
		return empty, false, threadInvalid()
	}
	if err := normalizeThreadMessage(&in.Message); err != nil {
		return empty, false, err
	}
	if in.Message.Mode != "queue" {
		return empty, false, threadInvalid()
	}
	if in.CreatedBy == "project_agent" && (!threadID(in.OriginConversationID) || !threadID(in.ProjectID) || !threadKey(in.OriginToolCallID)) {
		return empty, false, threadInvalid()
	}
	if in.CreatedBy == "employee" && (in.ProjectID != "" || in.OriginConversationID != "" || in.OriginToolCallID != "") {
		return empty, false, threadInvalid()
	}
	if !threadModel(in.Model) || in.Message.Model != "" {
		return empty, false, threadError(422, "model_invalid", "新建 Thread 时请在 model 指定有效模型")
	}
	raw, _ := json.Marshal(struct {
		Input                     CreateThreadInput
		Actor, Conversation, Tool string
	}{in, in.CreatedBy, in.OriginConversationID, in.OriginToolCallID})
	hash := sha256.Sum256(raw)
	lookup := func() (Thread, bool, error) {
		var id string
		var old []byte
		err := tx.QueryRow(ctx, `SELECT id::text,request_hash FROM threads WHERE employee_id=$1 AND client_thread_id=$2`, employeeID, in.ClientThreadID).Scan(&id, &old)
		if errors.Is(err, pgx.ErrNoRows) {
			return empty, false, nil
		}
		if err != nil {
			return empty, false, err
		}
		if string(old) != string(hash[:]) {
			return empty, true, threadConflict()
		}
		t, err := readThread(ctx, tx, employeeID, id, false)
		return t, true, err
	}
	if t, found, err := lookup(); found || err != nil {
		return t, false, err
	}
	var err error
	if in.NodeID == "" {
		in.NodeID, err = threadDefaultNode(ctx, tx, employeeID)
		if err != nil {
			return empty, false, err
		}
	}
	if err = threadNode(ctx, tx, employeeID, in.NodeID, in.AgentType, in.WorkingDirectory, false, &in.Model, false); err != nil {
		return empty, false, err
	}
	if in.ProjectID != "" {
		var valid bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects p WHERE p.employee_id=$1 AND p.id=$2 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM conversations c JOIN project_agents a ON a.id=c.agent_id WHERE c.id=$3 AND c.employee_id=$1 AND a.project_id=p.id)))`, employeeID, in.ProjectID, nullableProjectID(in.OriginConversationID)).Scan(&valid)
		if err != nil {
			return empty, false, err
		}
		if !valid {
			return empty, false, ErrNotFound
		}
	}
	id, err := identity.NewUUID()
	if err != nil {
		return empty, false, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO threads(id,employee_id,client_thread_id,request_hash,project_id,origin_conversation_id,origin_tool_call_id,node_id,agent_type,working_directory,execution_timeout_seconds,created_by,model)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(employee_id,client_thread_id) DO NOTHING`, id, employeeID, in.ClientThreadID, hash[:], nullableProjectID(in.ProjectID), nullableProjectID(in.OriginConversationID), nullableProjectID(in.OriginToolCallID), in.NodeID, in.AgentType, in.WorkingDirectory, in.ExecutionTimeoutSeconds, in.CreatedBy, in.Model)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return empty, false, threadConflict()
		}
		return empty, false, err
	}
	if tag.RowsAffected() == 0 {
		t, _, err := lookup()
		return t, false, err
	}
	t, err := readThread(ctx, tx, employeeID, id, false)
	if err != nil {
		return empty, false, err
	}
	if err = threadAudit(ctx, tx, t, "thread.created", t.CreatedBy, employeeID, map[string]any{"node_id": t.NodeID, "origin_tool_call_id": in.OriginToolCallID}); err != nil {
		return empty, false, err
	}
	if err = enqueueThreadCommand(ctx, tx, t, "open", map[string]string{"model": t.Model}); err != nil {
		return empty, false, err
	}
	if _, _, err = insertThreadMessage(ctx, tx, t, in.Message); err != nil {
		return empty, false, err
	}
	t, err = readThread(ctx, tx, employeeID, id, false)
	if err != nil {
		return empty, false, err
	}
	return t, true, nil
}

func insertThreadMessage(ctx context.Context, tx pgx.Tx, t Thread, in ThreadMessageInput) (ThreadMessage, bool, error) {
	var m ThreadMessage
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT to_jsonb(m) FROM thread_messages m WHERE employee_id=$1 AND thread_id=$2 AND client_message_id=$3`, t.EmployeeID, t.ID, in.ClientMessageID).Scan(&raw)
	if err == nil {
		if err = json.Unmarshal(raw, &m); err != nil {
			return m, false, err
		}
		if m.Content != in.Content || m.Mode != in.Mode || m.Model != in.Model || m.Sender != in.Sender || m.OriginToolCallID != in.OriginToolCallID {
			return m, false, threadConflict()
		}
		return m, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return m, false, err
	}
	if t.AgentType == "shell" {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_messages WHERE thread_id=$1)`, t.ID).Scan(&exists); err != nil {
			return m, false, err
		}
		if exists {
			return m, false, threadError(422, "shell_single_turn", "命令 Thread 只接受一条消息")
		}
	}
	if t.Status == "archived" || t.ArchiveRequestedAt != nil {
		return m, false, threadError(409, "thread_archived", "Thread 已归档或正在归档")
	}
	if t.Status == "stopped" && t.OpenedAt == nil {
		return m, false, threadError(422, "thread_not_opened", "会话未能启动，请查看停止原因并新建 Thread")
	}
	if in.Sender == "project_agent" && t.ProjectID == "" {
		return m, false, threadInvalid()
	}
	if in.Mode == "steer" || in.Model != "" {
		if err = threadNode(ctx, tx, t.EmployeeID, t.NodeID, t.AgentType, t.WorkingDirectory, in.Mode == "steer", &in.Model, true); err != nil {
			return m, false, err
		}
	}
	id, err := identity.NewUUID()
	if err != nil {
		return m, false, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO thread_messages(id,employee_id,thread_id,client_message_id,sender,origin_tool_call_id,content,mode,model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING to_jsonb(thread_messages)`, id, t.EmployeeID, t.ID, in.ClientMessageID, in.Sender, nullableProjectID(in.OriginToolCallID), in.Content, in.Mode, in.Model).Scan(&raw)
	if err != nil {
		return m, false, err
	}
	if err = json.Unmarshal(raw, &m); err != nil {
		return m, false, err
	}
	if err = enqueueThreadCommand(ctx, tx, t, "message", map[string]string{"client_message_id": in.ClientMessageID}); err != nil {
		return m, false, err
	}
	if err = threadAudit(ctx, tx, t, "message.accepted", m.Sender, t.EmployeeID, m); err != nil {
		return m, false, err
	}
	return m, true, touchThread(ctx, tx, t.ID)
}

func (s *Store) SendThreadMessage(ctx context.Context, employeeID, id string, in ThreadMessageInput) (ThreadMessage, error) {
	var m ThreadMessage
	if !threadID(employeeID) || !threadID(id) {
		return m, threadInvalid()
	}
	if err := normalizeThreadMessage(&in); err != nil {
		return m, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return m, err
	}
	defer tx.Rollback(ctx)
	t, err := readThread(ctx, tx, employeeID, id, true)
	if err != nil {
		return m, err
	}
	m, _, err = insertThreadMessage(ctx, tx, t, in)
	if err != nil {
		return m, err
	}
	return m, tx.Commit(ctx)
}

// RequestThreadAction 只记录意图；设备报告确认之前不改变执行状态。
func (s *Store) RequestThreadAction(ctx context.Context, employeeID, id, action, messageID string) (Thread, error) {
	var empty Thread
	if !threadID(employeeID) || !threadID(id) || (action != "stop" && action != "archive" && action != "withdraw") {
		return empty, threadInvalid()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(ctx)
	t, err := requestThreadActionTx(ctx, tx, employeeID, id, action, messageID, "employee", employeeID)
	if err != nil {
		return empty, err
	}
	return t, tx.Commit(ctx)
}

func requestThreadActionTx(ctx context.Context, tx pgx.Tx, employeeID, id, action, messageID, actor, actorID string) (Thread, error) {
	var empty Thread
	t, err := readThread(ctx, tx, employeeID, id, true)
	if err != nil {
		return empty, err
	}
	if t.Status == "archived" {
		if action == "archive" {
			return t, nil
		}
		return empty, threadConflict()
	}
	if action == "withdraw" {
		var m ThreadMessage
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT to_jsonb(m) FROM thread_messages m WHERE employee_id=$1 AND thread_id=$2 AND (client_message_id=$3 OR id::text=$3)`, employeeID, id, messageID).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return empty, ErrNotFound
		}
		if err != nil {
			return empty, err
		}
		if err = json.Unmarshal(raw, &m); err != nil {
			return empty, err
		}
		if m.Status == "withdrawn" {
			return t, nil
		}
		if m.Status != "accepted" && m.Status != "queued" {
			return empty, &ThreadError{Status: 409, Code: "message_already_sent", Message: "消息已发出或接收状态不确定", CurrentStatus: m.Status}
		}
		err = enqueueThreadCommand(ctx, tx, t, "withdraw", map[string]string{"client_message_id": m.ClientMessageID})
	} else {
		var active bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL) OR EXISTS(SELECT 1 FROM thread_messages WHERE thread_id=$1 AND status IN ('accepted','queued','unknown'))`, id).Scan(&active)
		if err != nil {
			return empty, err
		}
		if action == "archive" && !active && (t.Status == "idle" || t.Status == "stopped") {
			_, err = tx.Exec(ctx, `UPDATE threads SET status='archived',archived_at=clock_timestamp(),archive_requested_at=clock_timestamp() WHERE id=$1`, id)
			if err == nil {
				err = threadAudit(ctx, tx, t, "thread.archived", actor, actorID, map[string]any{})
			}
		} else if action == "stop" && !active && t.Status == "stopped" && t.OpenedAt == nil {
			_, err = tx.Exec(ctx, `UPDATE threads SET stop_requested_at=clock_timestamp(),stop_confirmed_at=clock_timestamp() WHERE id=$1`, id)
		} else {
			if action == "archive" {
				_, err = tx.Exec(ctx, `UPDATE threads SET archive_requested_at=COALESCE(archive_requested_at,clock_timestamp()) WHERE id=$1`, id)
			}
			if err == nil && (t.StopRequestedAt == nil || t.StopConfirmedAt != nil) {
				_, err = tx.Exec(ctx, `UPDATE threads SET stop_requested_at=clock_timestamp(),stop_confirmed_at=NULL WHERE id=$1`, id)
				if err == nil {
					err = enqueueThreadCommand(ctx, tx, t, "stop", map[string]any{})
				}
			}
		}
	}
	if err != nil {
		return empty, err
	}
	if err = threadAudit(ctx, tx, t, action+".requested", actor, actorID, map[string]string{"client_message_id": messageID}); err != nil {
		return empty, err
	}
	if err = touchThread(ctx, tx, id); err != nil {
		return empty, err
	}
	t, err = readThread(ctx, tx, employeeID, id, false)
	if err != nil {
		return empty, err
	}
	return t, nil
}

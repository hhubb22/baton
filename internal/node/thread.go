package node

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"
)

type sessionThreadHost struct {
	host   *session.Host
	ledger *Ledger
	nodeID string
}

func newSessionThreadHost(host *session.Host, ledger *Ledger, nodeID string) ThreadHost {
	if host == nil {
		return nil
	}
	return &sessionThreadHost{host: host, ledger: ledger, nodeID: nodeID}
}

func (h *sessionThreadHost) OpenThread(ctx context.Context, thread ThreadRecord) error {
	return h.host.OpenThread(ctx, session.ThreadOptions{
		ThreadID:                thread.ThreadID,
		StorageGeneration:       thread.StorageGeneration,
		NodeID:                  h.nodeID,
		AgentType:               thread.AgentType,
		Model:                   thread.Model,
		WorkingDirectory:        thread.WorkingDirectory,
		ExecutionTimeoutSeconds: thread.ExecutionTimeoutSeconds,
	})
}

func (h *sessionThreadHost) ThreadMessage(ctx context.Context, _ string, cmd protocol.ThreadCommand) error {
	return h.host.ThreadMessage(ctx, cmd.ThreadID, cmd.ClientMessageID, cmd.Content, cmd.Mode, cmd.Model)
}

func (h *sessionThreadHost) ThreadWithdraw(ctx context.Context, _ string, cmd protocol.ThreadCommand) error {
	return h.host.ThreadWithdraw(ctx, cmd.ThreadID, cmd.ClientMessageID)
}

func (h *sessionThreadHost) ThreadStop(ctx context.Context, _ string, cmd protocol.ThreadCommand) error {
	return h.host.ThreadStop(ctx, cmd.ThreadID, "stopped")
}

func (h *sessionThreadHost) ThreadPending(ctx context.Context, threadID string, fromSeq int64) ([]protocol.ThreadReport, error) {
	after := max(int64(0), fromSeq-1)
	reports, err := h.host.ThreadPending(ctx, threadID, after)
	if err != nil {
		return nil, err
	}
	if len(reports) > 32 {
		reports = reports[:32]
	}
	return reports, nil
}

func (h *sessionThreadHost) ThreadAck(ctx context.Context, threadID, eventID string, workerSeq int64) error {
	return h.host.ThreadAck(ctx, threadID, eventID, workerSeq)
}

func (h *sessionThreadHost) ThreadFailure(ctx context.Context, commandID, threadID, kind, reason string) error {
	if h.ledger == nil {
		return errors.New("节点账本不可用")
	}
	return h.ledger.nodeThreadFailure(ctx, commandID, threadID, kind, reason)
}

var errThreadReportLimit = errors.New("Thread 报告发送额度已用完")

// threadService 使用一个有界入口和一个处理循环，不在 WebSocket 读循环等待 Worker IPC。
type threadService struct {
	ledger       *Ledger
	host         ThreadHost
	budget       int64
	caps         []string
	send         func(context.Context, string, any) error
	inbox        chan protocol.Envelope
	ready        chan struct{}
	synced       atomic.Bool
	sent         map[string]time.Time
	historyRetry map[string]time.Time
	tokens       float64
	refill       time.Time
	scanAfter    string
}

func newThreadService(l *Ledger, host ThreadHost, budget int64, caps []string, send func(context.Context, string, any) error) *threadService {
	return &threadService{ledger: l, host: host, budget: budget, caps: append([]string(nil), caps...), send: send,
		inbox: make(chan protocol.Envelope, 64), ready: make(chan struct{}, 1), sent: make(map[string]time.Time), historyRetry: make(map[string]time.Time), tokens: 32, refill: time.Now()}
}

func (s *threadService) handle(env protocol.Envelope) bool {
	var kind struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(env.Body, &kind) != nil || (kind.Type != protocol.BodyThreadCommand && kind.Type != protocol.BodyThreadReportResult) {
		return false
	}
	if env.Source == nil || env.Source.Kind != protocol.SourceControl {
		return true
	}
	select {
	case s.inbox <- env:
	default:
	}
	return true
}

func (s *threadService) syncReady() {
	s.synced.Store(true)
	select {
	case s.ready <- struct{}{}:
	default:
	}
}

func (s *threadService) run(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case env := <-s.inbox:
			bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
			var kind struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(env.Body, &kind)
			if kind.Type == protocol.BodyThreadCommand {
				var cmd protocol.ThreadCommand
				if json.Unmarshal(env.Body, &cmd) == nil {
					if result, err := s.command(bounded, env.MessageID, cmd); err == nil {
						_ = s.send(bounded, env.MessageID, result)
					}
				}
			} else {
				var result protocol.ThreadReportResult
				if json.Unmarshal(env.Body, &result) == nil {
					_ = s.reportResult(bounded, result)
				}
			}
			cancel()
		case <-s.ready:
		case <-ticker.C:
		}
		if s.synced.Load() {
			bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
			_ = s.flush(bounded)
			cancel()
		}
	}
}

func validThreadClientID(s string) bool {
	if len(s) == 0 || len(s) > 256 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validThreadCommand(id string, cmd protocol.ThreadCommand) bool {
	if _, err := identity.ParseUUID(id); err != nil {
		return false
	}
	if _, err := identity.ParseUUID(cmd.ThreadID); err != nil {
		return false
	}
	if cmd.Type != protocol.BodyThreadCommand {
		return false
	}
	if !validModelText(cmd.Model) {
		return false
	}
	switch cmd.Action {
	case "open":
		return agentName.MatchString(cmd.AgentType) && cmd.WorkingDirectory != "" && cmd.ExecutionTimeoutSeconds >= 0
	case "message":
		if !validThreadClientID(cmd.ClientMessageID) {
			return false
		}
		return !(cmd.Mode == "steer" && cmd.Model != "") && cmd.Content != "" && len(cmd.Content) <= 64<<10 && utf8.ValidString(cmd.Content) && (cmd.Mode == "" || cmd.Mode == "queue" || cmd.Mode == "steer")
	case "withdraw":
		return validThreadClientID(cmd.ClientMessageID)
	case "stop":
		return true
	}
	return false
}

func (s *threadService) command(ctx context.Context, id string, cmd protocol.ThreadCommand) (protocol.ThreadCommandResult, error) {
	result := protocol.ThreadCommandResult{Type: protocol.BodyThreadCommandResult, ThreadID: cmd.ThreadID}
	if !validThreadCommand(id, cmd) {
		result.Code = "invalid_command"
		return result, nil
	}
	if s.ledger == nil {
		return result, errors.New("节点账本不可用")
	}
	if saved, ok, err := s.ledger.threadReceipt(ctx, id, cmd); err != nil {
		return result, err
	} else if ok {
		return saved, nil
	}
	record, err := s.ledger.Thread(ctx, cmd.ThreadID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	found := err == nil
	if found && record.Status == "history_missing" {
		result.Code = "history_missing"
		if err := s.ledger.saveThreadReceipt(ctx, id, cmd, result); err != nil {
			return result, err
		}
		return result, nil
	}
	if cmd.Action == "open" {
		if found {
			if record.AgentType != cmd.AgentType || record.Model != cmd.Model || record.WorkingDirectory != cmd.WorkingDirectory || record.ExecutionTimeoutSeconds != cmd.ExecutionTimeoutSeconds {
				result.Code = "thread_conflict"
				return result, nil
			}
		} else {
			if err := s.ledger.CheckThreadBudget(ctx, s.budget); err != nil {
				if errors.Is(err, ErrThreadBudget) {
					result.Code = "storage_budget_exceeded"
					return result, nil
				}
				return result, err
			}
			if err := s.ledger.insertThread(ctx, id, cmd); err != nil {
				return result, err
			}
			record, err = s.ledger.Thread(ctx, cmd.ThreadID)
			if err != nil {
				return result, err
			}
		}
		if record.Status == "opening" {
			failure := validateThreadDirectory(s.ledger.dir, record.WorkingDirectory)
			if failure == nil {
				failure = s.agentAvailable(ctx, record.AgentType)
			}
			if failure == nil && s.host == nil {
				failure = errors.New("Thread Worker 接口不可用")
			}
			if failure == nil {
				if err := s.host.OpenThread(ctx, record); err != nil {
					return result, err
				}
			}
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			if failure != nil {
				if err := s.ledger.nodeThreadFailure(ctx, record.OpenMessageID, cmd.ThreadID, "thread.open_failed", failure.Error()); err != nil {
					return result, err
				}
			} else if err := s.ledger.threadStatus(ctx, cmd.ThreadID, "ready"); err != nil {
				return result, err
			}
		}
	} else if !found || cmd.StorageGeneration == "" || cmd.StorageGeneration != s.ledger.Generation() || cmd.StorageGeneration != record.StorageGeneration {
		if found && record.Status == "ready" {
			if s.host == nil {
				return result, errors.New("Thread Worker 接口不可用")
			}
			if err := s.host.ThreadFailure(ctx, id, cmd.ThreadID, "thread.stopped", "本地历史缺失"); err != nil {
				return result, err
			}
		} else if err := s.ledger.nodeThreadFailure(ctx, id, cmd.ThreadID, "thread.stopped", "本地历史缺失"); err != nil {
			return result, err
		}
	} else {
		if cmd.Action == "message" {
			if err := s.ledger.CheckThreadBudget(ctx, s.budget); err != nil {
				if errors.Is(err, ErrThreadBudget) {
					result.Code = "storage_budget_exceeded"
					return result, nil
				}
				return result, err
			}
		}
		// open_failed 的 Thread 从未建立 Worker，不允许后续命令新开空会话。
		if record.Status != "ready" {
			if err := s.ledger.nodeThreadFailure(ctx, id, cmd.ThreadID, "thread.stopped", "本地历史缺失"); err != nil {
				return result, err
			}
		} else {
			if s.host == nil {
				return result, errors.New("Thread Worker 接口不可用")
			}
			switch cmd.Action {
			case "message":
				err = s.host.ThreadMessage(ctx, id, cmd)
			case "withdraw":
				err = s.host.ThreadWithdraw(ctx, id, cmd)
			case "stop":
				err = s.host.ThreadStop(ctx, id, cmd)
			}
			if err != nil {
				return result, err
			}
		}
	}
	result.OK = true
	if err := s.ledger.saveThreadReceipt(ctx, id, cmd, result); err != nil {
		return result, err
	}
	return result, nil
}

func (s *threadService) agentAvailable(ctx context.Context, agent string) error {
	if agent == "shell" {
		cfg, err := ReadProjectExec(s.ledger.dir)
		if err != nil || !cfg.Enabled {
			return errors.New("本地 project-exec 未启用")
		}
		if _, err := defaultAgentProbe().lookup(cfg.Shell); err != nil {
			return errors.New("缺少本地 shell 可执行文件")
		}
		return nil
	}
	if agent != "pi" && agent != "codex" && agent != "kiro" {
		return errors.New("不支持此 Agent 类型")
	}
	if !containsCap(s.caps, agent) {
		return errors.New("节点未启用此 Agent")
	}
	if _, err := threadAgentLookup(agent); err != nil {
		return errors.New("缺少 Agent 可执行文件：" + threadAgentBinary(agent))
	}
	return ctx.Err()
}

func (s *threadService) pending(ctx context.Context, id string, from int64) ([]protocol.ThreadReport, error) {
	record, err := s.ledger.Thread(ctx, id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err == nil && record.Status == "ready" && s.host != nil && !time.Now().Before(s.historyRetry[id]) {
		worker, err := s.host.ThreadPending(ctx, id, from)
		if errors.Is(err, session.ErrHistoryUnread) {
			// 每次读取仍受调用期限限制；暂时 I/O 错误不占用报告序号。
			s.historyRetry[id] = time.Now().Add(time.Second)
		} else if err != nil {
			handled, saveErr := s.ledger.threadHistoryFailure(ctx, id, err)
			if saveErr != nil {
				return nil, saveErr
			}
			if !handled {
				return nil, err
			}
		} else {
			delete(s.historyRetry, id)
			if len(worker) > 32 {
				return nil, errors.New("Worker 报告批次超过上限")
			}
			if err := s.ledger.cacheThreadWorkerReports(ctx, id, worker); err != nil {
				return nil, err
			}
		}
	}
	local, err := s.ledger.nodeThreadPending(ctx, id, from)
	if err != nil {
		return nil, err
	}
	worker, err := s.ledger.cachedThreadWorkerReports(ctx, id, from)
	if err != nil {
		return nil, err
	}
	local = append(local, worker...)
	sort.Slice(local, func(i, j int) bool { return local[i].WorkerSeq < local[j].WorkerSeq })
	if len(local) > 32 {
		local = local[:32]
	}
	return local, nil
}

func (s *threadService) flushThread(ctx context.Context, id string, from int64) error {
	pending, err := s.pending(ctx, id, from)
	if err != nil {
		return err
	}
	var previous int64
	for _, report := range pending {
		if report.ThreadID != id || report.WorkerSeq < from || report.WorkerSeq <= previous || report.EventID == "" {
			return errors.New("Worker 报告身份或序号无效")
		}
		previous = report.WorkerSeq
		if last, ok := s.sent[report.EventID]; ok && time.Since(last) < time.Second {
			continue
		}
		now := time.Now()
		s.tokens = min(32, s.tokens+now.Sub(s.refill).Seconds()*32)
		s.refill = now
		if s.tokens < 1 {
			return errThreadReportLimit
		}
		report.Type = protocol.BodyThreadReport
		if report.Kind == "thread.opened" {
			report.StorageGeneration = s.ledger.Generation()
		}
		if err := s.ledger.noteThreadSeq(ctx, id, report.WorkerSeq); err != nil {
			return err
		}
		if err := s.send(ctx, "", report); err != nil {
			return err
		}
		s.tokens--
		s.sent[report.EventID] = time.Now()
	}
	return nil
}

func (s *threadService) flush(ctx context.Context) error {
	if s.ledger == nil {
		return nil
	}
	ids, err := s.ledger.threadIDs(ctx)
	if err != nil {
		return err
	}
	var first error
	start := sort.SearchStrings(ids, s.scanAfter)
	if start < len(ids) && ids[start] == s.scanAfter {
		start++
	}
	for i := 0; i < len(ids); i++ {
		id := ids[(start+i)%len(ids)]
		if err := ctx.Err(); err != nil {
			return err
		}
		err := s.flushThread(ctx, id, 1)
		if errors.Is(err, errThreadReportLimit) {
			return nil
		}
		s.scanAfter = id
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *threadService) reportResult(ctx context.Context, result protocol.ThreadReportResult) error {
	if s.ledger == nil || result.Type != protocol.BodyThreadReportResult || result.EventID == "" || result.WorkerSeq < 1 {
		return nil
	}
	pending, err := s.pending(ctx, result.ThreadID, result.WorkerSeq)
	if err != nil {
		return err
	}
	matched := false
	for _, r := range pending {
		if r.EventID == result.EventID && r.WorkerSeq == result.WorkerSeq {
			matched = true
			break
		}
	}
	if !matched {
		return nil
	}
	if result.OK {
		delete(s.sent, result.EventID)
		res, err := s.ledger.db.ExecContext(ctx, `UPDATE thread_node_reports SET acked=1 WHERE thread_id=? AND event_id=? AND worker_seq=? AND acked=0`, result.ThreadID, result.EventID, result.WorkerSeq)
		if err != nil {
			return err
		}
		count, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			if _, err := s.ledger.db.ExecContext(ctx, `DELETE FROM thread_worker_reports WHERE thread_id=? AND event_id=? AND worker_seq=?`, result.ThreadID, result.EventID, result.WorkerSeq); err != nil {
				return err
			}
			record, err := s.ledger.Thread(ctx, result.ThreadID)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil && record.Status == "ready" && s.host != nil {
				return s.host.ThreadAck(ctx, result.ThreadID, result.EventID, result.WorkerSeq)
			}
		}
		return nil
	}
	if result.Code == "worker_sequence_gap" && result.ExpectedWorkerSeq > 0 {
		if err := s.ledger.alignMissingThreadReports(ctx, result.ThreadID, result.ExpectedWorkerSeq); err != nil {
			return err
		}
		retry, err := s.pending(ctx, result.ThreadID, result.ExpectedWorkerSeq)
		if err != nil {
			return err
		}
		for _, r := range retry {
			delete(s.sent, r.EventID)
		}
		return s.flushThread(ctx, result.ThreadID, result.ExpectedWorkerSeq)
	}
	return nil
}

func writeThreadEnvelope(ctx context.Context, w *wsWriter, correlation string, value any) error {
	messageID, err := identity.NewUUID()
	if err != nil {
		return err
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	env, err := json.Marshal(protocol.Envelope{Version: protocol.Version, MessageID: messageID, CorrelationID: correlation,
		Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, Body: body})
	if err != nil {
		return err
	}
	raw, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil {
		return err
	}
	if len(raw) > protocol.MaxMessageBytes {
		return errors.New("Thread 消息超过传输上限")
	}
	return w.write(ctx, raw)
}

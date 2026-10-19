package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"
	"baton/internal/task"
)

func (s *startLoop) followInput(job *startJob) {
	if err := waitExecutionGate(s.ctx, job.executionID, "BATON_TEST_INPUT_GATE", "event=input_gated", s.log); err != nil {
		return
	}
	if !s.checkControl(s.ctx, job) {
		return
	}
	var payload string
	var err error
	for attempt := 1; attempt <= 5; attempt++ {
		payload, err = s.fetchInput(s.ctx, job)
		if err == nil {
			break
		}
		timer := time.NewTimer(time.Duration(attempt) * 100 * time.Millisecond)
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
	if err != nil || strings.TrimSpace(payload) == "" {
		s.log.Info("event=input_fetch_failed", "task_id", job.taskID)
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	st, err := s.host.SubmitInput(ctx, job.sessionID, payload)
	cancel()
	if err != nil {
		s.log.Info("event=input_submit_failed", "task_id", job.taskID)
		return
	}
	s.log.Info("event=input_submitted", "task_id", job.taskID, "execution_id", job.executionID, "inputs", st.ExecutorInputs)
	s.deliver(s.ctx, job.sessionID, st.Reports)
}

func (s *startLoop) resendPending(ctx context.Context) {
	if s == nil || s.ledger == nil || s.host == nil {
		return
	}
	sessions, err := s.ledger.WorkerSessions()
	if err != nil {
		return
	}
	for _, id := range sessions {
		if ctx.Err() != nil {
			return
		}
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := s.host.Pending(callCtx, id)
		cancel()
		if err == nil {
			s.clearHistoryReadFailures(id)
			if !s.syncStatusReceipts(ctx, id, st) {
				continue
			}
			if len(st.Reports) > 0 {
				s.deliver(ctx, id, st.Reports)
			}
			if st.TaskID != "" && st.ExecutionID != "" && !st.Cancelled {
				if !s.checkControl(ctx, &startJob{taskID: st.TaskID, executionID: st.ExecutionID, sessionID: id}) {
					continue
				}
			}
			if st.TaskID != "" && st.ExecutionID != "" {
				_ = s.receiveChildren(ctx, &startJob{taskID: st.TaskID, executionID: st.ExecutionID, sessionID: id}, "", false)
			}
			if st.Cancelled || st.Uncertain || st.InputSubmitted || !st.StartIntent || st.TaskID == "" || st.ExecutionID == "" {
				continue
			}
			s.log.Info("event=input_resend", "task_id", st.TaskID, "execution_id", st.ExecutionID, "input_due_at", st.InputDueAt)
			s.followInput(&startJob{
				taskID: st.TaskID, executionID: st.ExecutionID, sessionID: id,
			})
			continue
		}
		failures, stateErr := s.ledger.historyReadFailures(id)
		if stateErr != nil {
			s.log.Info("event=history_retry_state_failed", "session_id", id)
			continue
		}
		if failures >= historyReadFailureLimit {
			s.reportHistory(ctx, id)
			continue
		}
		path, pathErr := session.LedgerPath(s.host.DataDir, id)
		if pathErr != nil {
			continue
		}
		needs, readErr := session.LedgerNeedsWorker(path)
		if readErr != nil {
			s.historyReadFailed(ctx, id, readErr)
			continue
		}
		if !needs {
			s.clearHistoryReadFailures(id)
			continue
		}
		s.reconcile(ctx, id)
	}
}

func (s *startLoop) reconcile(ctx context.Context, sessionID string) {
	err := s.host.Reconcile(ctx, sessionID)
	if err == nil {
		s.clearHistoryReadFailures(sessionID)
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, pendingErr := s.host.Pending(callCtx, sessionID)
		cancel()
		if pendingErr == nil && s.syncStatusReceipts(ctx, sessionID, st) && len(st.Reports) > 0 {
			s.deliver(ctx, sessionID, st.Reports)
		}
		return
	}
	if s.historyReadFailed(ctx, sessionID, err) {
		return
	}
	s.log.Info("event=worker_missing", "session_id", sessionID)
}

func (s *startLoop) clearHistoryReadFailures(sessionID string) {
	if err := s.ledger.clearHistoryReadFailures(sessionID); err != nil {
		s.log.Info("event=history_retry_state_failed", "session_id", sessionID)
	}
}

func (s *startLoop) historyReadFailed(ctx context.Context, sessionID string, err error) bool {
	if errors.Is(err, session.ErrHistoryMissing) || errors.Is(err, session.ErrHistoryIncompatible) {
		s.log.Info("event=history_unreadable", "session_id", sessionID, "reason", err.Error())
		s.reportHistory(ctx, sessionID)
		return true
	}
	if errors.Is(err, session.ErrHistoryUnread) {
		failures, stateErr := s.ledger.recordHistoryReadFailure(sessionID)
		if stateErr != nil {
			s.log.Info("event=history_retry_state_failed", "session_id", sessionID)
			return true
		}
		s.log.Info("event=history_read_failed", "session_id", sessionID, "reason", err.Error(), "attempt", failures)
		if failures >= historyReadFailureLimit {
			s.log.Info("event=history_read_exhausted", "session_id", sessionID)
			s.reportHistory(ctx, sessionID)
		}
		return true
	}
	return false
}

func (s *startLoop) reportHistory(ctx context.Context, sessionID string) {
	s.mu.Lock()
	if s.reported == nil {
		s.reported = map[string]bool{}
	}
	if s.reported[sessionID] {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	taskID, executionID, ok, err := s.ledger.TaskForSession(sessionID)
	if err != nil || !ok {
		return
	}
	eventID, err := session.VerificationEventID(executionID, task.CodeUncertainHistory)
	if err != nil {
		return
	}
	body, err := json.Marshal(protocol.ExecutionReport{
		Type: protocol.BodyExecutionReport, EventID: eventID, TaskID: taskID, ExecutionID: executionID,
		SessionID: sessionID, Kind: protocol.ReportNeedsVerification, Status: task.StatusNeedsVerification,
		ErrorCode: task.CodeUncertainHistory,
	})
	if err != nil {
		return
	}
	if err := s.pushReport(ctx, body); err != nil {
		if err.Error() == task.CodeInvalidTarget {
			s.mu.Lock()
			s.reported[sessionID] = true
			s.mu.Unlock()
		}
		s.log.Info("event=history_report_failed", "session_id", sessionID)
		return
	}
	s.mu.Lock()
	s.reported[sessionID] = true
	s.mu.Unlock()
	s.log.Info("event=history_reported", "session_id", sessionID, "task_id", taskID)
}

func (s *startLoop) fetchInput(ctx context.Context, job *startJob) (string, error) {
	body, err := json.Marshal(protocol.InputRequest{
		Type: protocol.BodyExecutionInput, TaskID: job.taskID, ExecutionID: job.executionID, SessionID: job.sessionID,
	})
	if err != nil {
		return "", err
	}
	raw, err := s.roundTrip(ctx, body)
	if err != nil {
		return "", err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var result protocol.InputResult
	if err := dec.Decode(&result); err != nil || result.Type != protocol.BodyExecutionInputResult || !result.OK {
		if result.Code != "" {
			return "", errors.New(result.Code)
		}
		return "", errors.New("任务输入无效")
	}
	if strings.TrimSpace(result.Description) == "" {
		return "", errors.New("任务输入无效")
	}
	payload, err := task.MarshalExecutorInput(
		result.Description, result.AuthorizationScope, result.ExpectedOutputs,
		result.WorkingDirectory, result.DeviceNames, result.Generation,
		result.RequiredArtifacts,
	)
	if err != nil {
		return "", err
	}
	return string(payload), nil
}

func (s *startLoop) deliver(ctx context.Context, sessionID string, reports []session.Report) {
	duplicate := os.Getenv("BATON_TEST_DUPLICATE_REPORT") == "1"
	for _, rep := range reports {
		if err := s.pushReport(ctx, rep.Body); err != nil {
			s.log.Info("event=execution_report_failed", "event_id", rep.EventID, "kind", rep.Kind)
			return
		}
		if rep.Kind == protocol.ReportResult {
			session.CrashAfter("ack")
		}
		if duplicate && rep.Kind == protocol.ReportResult {
			if err := s.pushReport(ctx, rep.Body); err != nil {
				s.log.Info("event=execution_report_failed", "event_id", rep.EventID, "kind", rep.Kind)
				return
			}
		}
		ackCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := s.host.Ack(ackCtx, sessionID, rep.EventID)
		cancel()
		if err != nil {
			s.log.Info("event=execution_ack_failed", "event_id", rep.EventID)
			return
		}
		s.log.Info("event=execution_report_acked", "event_id", rep.EventID, "kind", rep.Kind)
		if rep.Kind == protocol.ReportStarted {
			session.CrashAfter("after_started")
		}
	}
}

func (s *startLoop) pushReport(ctx context.Context, body json.RawMessage) error {
	raw, err := s.roundTrip(ctx, body)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var ack protocol.ReportAck
	if err := dec.Decode(&ack); err != nil || ack.Type != protocol.BodyExecutionReportResult || !ack.OK {
		if ack.Code != "" {
			return errors.New(ack.Code)
		}
		return errors.New("执行记录没有保存")
	}
	return nil
}

func (s *startLoop) roundTrip(ctx context.Context, body []byte) (json.RawMessage, error) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return nil, err
	}
	env, err := protocol.MarshalJSON(protocol.Envelope{
		Version: protocol.Version, MessageID: messageID,
		Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, Body: body,
	})
	if err != nil || len(env) > protocol.MaxMessageBytes {
		return nil, errors.New("消息超过上限")
	}
	frame, err := protocol.MarshalJSON(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		return nil, errors.New("消息超过上限")
	}
	ch := s.register(messageID)
	defer s.unregister(messageID)
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := s.writer.write(callCtx, frame); err != nil {
		return nil, err
	}
	select {
	case <-callCtx.Done():
		return nil, callCtx.Err()
	case raw := <-ch:
		return raw, nil
	}
}

func (s *startLoop) register(messageID string) chan json.RawMessage {
	ch := make(chan json.RawMessage, 1)
	s.mu.Lock()
	if s.waiters == nil {
		s.waiters = map[string]chan json.RawMessage{}
	}
	s.waiters[messageID] = ch
	s.mu.Unlock()
	return ch
}

func (s *startLoop) unregister(messageID string) {
	s.mu.Lock()
	delete(s.waiters, messageID)
	s.mu.Unlock()
}

func (s *startLoop) onReply(env protocol.Envelope) bool {
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(env.Body, &kind); err != nil {
		return false
	}
	switch kind.Type {
	case protocol.BodyProjectRuntimeResult, protocol.BodyExecutionInputResult, protocol.BodyExecutionReportResult, protocol.BodyExecutionControlResult, protocol.BodyAgentResult, protocol.BodyChildDeliveriesResult:
	default:
		return false
	}
	s.mu.Lock()
	ch := s.waiters[env.CorrelationID]
	s.mu.Unlock()
	if ch != nil {
		select {
		case ch <- append(json.RawMessage(nil), env.Body...):
		default:
		}
	}
	return true
}

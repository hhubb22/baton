package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/session"
)

// startLoop 在准备完成之后向中心申请启动许可，并只在 Worker 接受许可后进入启动。
type startLoop struct {
	ctx    context.Context
	ident  Identity
	ledger *Ledger
	host   *session.Host
	writer *wsWriter
	log    *slog.Logger

	mu       sync.Mutex
	jobs     map[string]*startJob
	waiters  map[string]chan json.RawMessage
	reported map[string]bool
}

type startJob struct {
	taskID      string
	executionID string
	sessionID   string
	generation  string
	nonce       string
	messageID   string
	attempts    int
	done        bool
}

func newStartLoop(ctx context.Context, ident Identity, ledger *Ledger, host *session.Host, writer *wsWriter, log *slog.Logger) *startLoop {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &startLoop{
		ctx: ctx, ident: ident, ledger: ledger, host: host, writer: writer, log: log,
		jobs: map[string]*startJob{},
	}
}

func (s *startLoop) afterPrepare(report PrepareReport) {
	if s == nil || s.host == nil || s.ledger == nil || !report.OK || os.Getenv("BATON_TEST_HOLD_START") == "1" {
		return
	}
	if _, err := s.ident.StartPublicKey(); err != nil {
		s.log.Info("event=start_skipped", "task_id", report.TaskID, "reason", "no_public_key")
		return
	}
	go s.request(report)
}

func (s *startLoop) request(report PrepareReport) {
	if err := waitGate(s.ctx, report.ExecutionID, s.log); err != nil {
		return
	}
	armCtx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	nonce, err := s.host.Arm(armCtx, report.SessionID, report.TaskID, report.ExecutionID)
	cancel()
	if err != nil || nonce == "" {
		s.log.Info("event=start_arm_failed", "task_id", report.TaskID)
		return
	}
	job := &startJob{
		taskID: report.TaskID, executionID: report.ExecutionID, sessionID: report.SessionID,
		generation: report.StorageGeneration, nonce: nonce,
	}
	s.mu.Lock()
	s.jobs[report.ExecutionID] = job
	s.mu.Unlock()
	s.send(job)
}

func (s *startLoop) send(job *startJob) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return
	}
	s.mu.Lock()
	if job.done {
		s.mu.Unlock()
		return
	}
	job.messageID = messageID
	job.attempts++
	s.mu.Unlock()
	body, err := json.Marshal(protocol.StartPermitRequest{
		Type:              protocol.BodyStartPermit,
		TaskID:            job.taskID,
		ExecutionID:       job.executionID,
		SessionID:         job.sessionID,
		StorageGeneration: job.generation,
		Nonce:             job.nonce,
	})
	if err != nil {
		return
	}
	env, err := json.Marshal(protocol.Envelope{
		Version:   protocol.Version,
		MessageID: messageID,
		Route:     protocol.Route{To: protocol.ToControl},
		Priority:  protocol.PriorityControl,
		Body:      body,
	})
	if err != nil || len(env) > protocol.MaxMessageBytes {
		return
	}
	frame, err := json.Marshal(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil || len(frame) > protocol.MaxMessageBytes {
		return
	}
	if err := s.writer.write(s.ctx, frame); err != nil {
		s.log.Info("event=start_permit_send_failed", "task_id", job.taskID)
		return
	}
	s.log.Info("event=start_permit_requested", "task_id", job.taskID, "execution_id", job.executionID, "message_id", messageID)
}

func (s *startLoop) onResult(env protocol.Envelope) bool {
	if s == nil {
		return false
	}
	var result protocol.StartPermitResult
	dec := json.NewDecoder(bytes.NewReader(env.Body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&result); err != nil || result.Type != protocol.BodyStartPermitResult {
		return false
	}
	job := s.jobByMessage(env.CorrelationID)
	if job == nil {
		return true
	}
	if !result.OK {
		s.mu.Lock()
		attempts := job.attempts
		s.mu.Unlock()
		if result.Code == "unavailable" && attempts < 8 {
			time.AfterFunc(time.Duration(attempts)*100*time.Millisecond, func() { s.send(job) })
			return true
		}
		s.finish(job)
		s.log.Info("event=start_rejected", "task_id", job.taskID, "code", result.Code)
		return true
	}
	s.finish(job)
	go s.authorize(job, result.Permit)
	return true
}

func (s *startLoop) authorize(job *startJob, permit string) {
	if forced := strings.TrimSpace(os.Getenv("BATON_TEST_PERMIT_FILE")); forced != "" {
		if os.Getenv("BATON_TEST_WAIT_PERMIT_FILE") == "1" {
			s.log.Info("event=start_permit_held", "task_id", job.taskID)
			deadline := time.Now().Add(20 * time.Second)
			for time.Now().Before(deadline) && s.ctx.Err() == nil {
				raw, err := os.ReadFile(forced)
				if err == nil && strings.TrimSpace(string(raw)) != "" {
					permit = strings.TrimSpace(string(raw))
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
		} else if raw, err := os.ReadFile(forced); err == nil && strings.TrimSpace(string(raw)) != "" {
			permit = strings.TrimSpace(string(raw))
		}
	}
	pub := s.ident.SigningPublicKey
	expires, err := s.ledger.QueueExpiry(job.taskID)
	if err != nil {
		s.log.Info("event=start_rejected", "task_id", job.taskID, "code", "invalid_target")
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	st, err := s.host.Authorize(ctx, job.sessionID, job.taskID, job.executionID, permit, pub, job.generation, expires.UTC().Format(time.RFC3339Nano))
	var refused *session.StartError
	if errors.As(err, &refused) {
		s.log.Info("event=start_rejected", "task_id", job.taskID, "code", refused.Code)
		s.reportRefusal(job, refused.Code)
		return
	}
	if err != nil {
		s.log.Info("event=start_authorize_failed", "task_id", job.taskID)
		return
	}
	if st.Started || st.StartIntent {
		s.log.Info("event=start_entered", "task_id", job.taskID, "execution_id", job.executionID, "starts", st.ExecutorStarts)
		s.followInput(job)
	}
}

func (s *startLoop) reportRefusal(job *startJob, code string) {
	messageID, err := identity.NewUUID()
	if err != nil {
		return
	}
	body, err := json.Marshal(protocol.StartReport{
		Type: protocol.BodyStartReport, TaskID: job.taskID, ExecutionID: job.executionID, Code: code,
	})
	if err != nil {
		return
	}
	env, err := json.Marshal(protocol.Envelope{
		Version: protocol.Version, MessageID: messageID,
		Route: protocol.Route{To: protocol.ToControl}, Priority: protocol.PriorityControl, Body: body,
	})
	if err != nil {
		return
	}
	frame, err := json.Marshal(struct {
		Kind     string          `json:"kind"`
		Envelope json.RawMessage `json:"envelope"`
	}{Kind: protocol.KindEnvelope, Envelope: env})
	if err != nil {
		return
	}
	if err := s.writer.write(s.ctx, frame); err != nil {
		return
	}
	s.log.Info("event=start_refusal_sent", "task_id", job.taskID, "execution_id", job.executionID, "code", code)
}

func (s *startLoop) jobByMessage(messageID string) *startJob {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, job := range s.jobs {
		if job.messageID == messageID && !job.done {
			return job
		}
	}
	return nil
}

func (s *startLoop) finish(job *startJob) {
	s.mu.Lock()
	job.done = true
	s.mu.Unlock()
}

func waitGate(ctx context.Context, executionID string, log *slog.Logger) error {
	dir := strings.TrimSpace(os.Getenv("BATON_TEST_START_GATE"))
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	waiting := filepath.Join(dir, "waiting-"+executionID)
	if err := os.WriteFile(waiting, []byte("1\n"), 0o600); err != nil {
		return err
	}
	if log != nil {
		log.Info("event=start_gated", "execution_id", executionID)
	}
	release := filepath.Join(dir, "release-"+executionID)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := os.Stat(release); err == nil {
			return nil
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

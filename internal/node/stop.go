package node

import (
	"context"
	"encoding/json"
	"time"

	"baton/internal/protocol"
)

func (s *startLoop) checkControl(ctx context.Context, job *startJob) bool {
	body, err := json.Marshal(protocol.InputRequest{Type: protocol.BodyExecutionControl, TaskID: job.taskID, ExecutionID: job.executionID, SessionID: job.sessionID})
	if err != nil {
		return false
	}
	raw, err := s.roundTrip(ctx, body)
	if err != nil {
		return false
	}
	var result protocol.ExecutionControl
	if err := json.Unmarshal(raw, &result); err != nil || !result.OK || result.Type != protocol.BodyExecutionControlResult {
		return false
	}
	if result.StopReason == "" {
		return true
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	st, err := s.host.Stop(callCtx, job.sessionID, result.StopReason)
	if err == nil {
		s.deliver(ctx, job.sessionID, st.Reports)
	}
	return false
}

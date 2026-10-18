package node

import (
	"context"
	"encoding/json"
	"errors"

	"baton/internal/protocol"
	"baton/internal/session"
)

func (s *startLoop) childRoundTrip(ctx context.Context, req protocol.ChildDeliveryRequest) (protocol.ChildDeliveriesResult, error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return protocol.ChildDeliveriesResult{}, err
	}
	raw, err = s.roundTrip(ctx, raw)
	if err != nil {
		return protocol.ChildDeliveriesResult{}, err
	}
	var result protocol.ChildDeliveriesResult
	if err := json.Unmarshal(raw, &result); err != nil || !result.OK || result.Type != protocol.BodyChildDeliveriesResult {
		return result, errors.New("子结果交付尚未确认")
	}
	return result, nil
}

func (s *startLoop) syncChildReceipts(ctx context.Context, job *startJob, receipts []protocol.ChildReceipt) error {
	for _, receipt := range receipts {
		_, err := s.childRoundTrip(ctx, protocol.ChildDeliveryRequest{InputRequest: protocol.InputRequest{
			Type: protocol.BodyChildDeliveryAck, TaskID: job.taskID, ExecutionID: job.executionID, SessionID: job.sessionID}, Receipt: &receipt})
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *startLoop) receiveChildren(ctx context.Context, job *startJob, childID string, queried bool) error {
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	// 不调用 Reconcile；通知本身不能拉起已停止的来源。
	st, err := s.host.Pending(ctx, job.sessionID)
	if err != nil {
		if queried {
			return nil
		}
		return err
	}
	if err := s.syncChildReceipts(ctx, job, st.ChildReceipts); err != nil {
		return err
	}
	result, err := s.childRoundTrip(ctx, protocol.ChildDeliveryRequest{InputRequest: protocol.InputRequest{
		Type: protocol.BodyChildDeliveries, TaskID: job.taskID, ExecutionID: job.executionID, SessionID: job.sessionID}, ChildTaskID: childID})
	if err != nil {
		return err
	}
	for _, delivery := range result.Deliveries {
		st, err = s.host.ReceiveChild(ctx, job.sessionID, delivery, queried)
		if err != nil {
			return err
		}
		if err := s.syncChildReceipts(ctx, job, st.ChildReceipts); err != nil {
			return err
		}
		s.deliver(ctx, job.sessionID, st.Reports)
	}
	return nil
}

// 防止新增交付前的报告越过本地尚未补交的代次事实。
func (s *startLoop) syncStatusReceipts(ctx context.Context, id string, st session.Status) bool {
	if len(st.ChildReceipts) == 0 {
		return true
	}
	s.deliveryMu.Lock()
	defer s.deliveryMu.Unlock()
	return s.syncChildReceipts(ctx, &startJob{taskID: st.TaskID, executionID: st.ExecutionID, sessionID: id}, st.ChildReceipts) == nil
}

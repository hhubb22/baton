package node

import (
	"context"

	"baton/internal/protocol"
)

type projectWakeReceipt struct {
	command protocol.ProjectRunCommand
	loop    *startLoop
}

func (m *projectRuntimeManager) receiveWake(command protocol.ProjectRunCommand) {
	if len(command.InputIDs) > 32 {
		return
	}
	for _, id := range command.InputIDs {
		if id <= 0 {
			return
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.runs[command.RunID]
	if m.closed || p == nil || p.stopped || p.command.LeaseEpoch != command.LeaseEpoch || p.ctx.Err() != nil {
		return
	}
	if p.started {
		if _, err := m.leaseTime(p); err != nil {
			p.stop()
			return
		}
	}
	p.notifyThreadWaits(command.ThreadUpdates)
	select {
	case p.wake <- struct{}{}:
	default:
	}
	if !m.controlReceipts || m.loop == nil || len(command.InputIDs) == 0 {
		return
	}
	// 通知已经合并，队列满只丢回执。中心重发时可重新确认相同输入。
	receipt := projectWakeReceipt{command: protocol.ProjectRunCommand{RunID: command.RunID, LeaseEpoch: command.LeaseEpoch, InputIDs: append([]int64(nil), command.InputIDs...)}, loop: m.loop}
	select {
	case m.wakeReceipts <- receipt:
	default:
	}
}

func (m *projectRuntimeManager) wakeReceiptLoop() {
	for {
		select {
		case <-m.ctx.Done():
			return
		case receipt := <-m.wakeReceipts:
			if m.ctx.Err() != nil {
				return
			}
			m.sendWakeReceipt(receipt)
		}
	}
}

func (m *projectRuntimeManager) sendWakeReceipt(receipt projectWakeReceipt) {
	m.mu.Lock()
	p := m.runs[receipt.command.RunID]
	valid := !m.closed && m.controlReceipts && m.loop == receipt.loop && p != nil && !p.stopped && p.command.LeaseEpoch == receipt.command.LeaseEpoch && p.ctx.Err() == nil
	if valid && p.started {
		_, err := m.leaseTime(p)
		valid = err == nil
	}
	m.mu.Unlock()
	if !valid {
		return
	}
	payload, _ := protocol.MarshalJSON(struct {
		InputIDs []int64 `json:"input_ids"`
	}{receipt.command.InputIDs})
	ctx, cancel := context.WithTimeout(m.ctx, projectReceiptTimeout)
	defer cancel()
	// 固定到观察过能力的连接，重连到旧中心时不会发送新操作。
	m.callOnLoop(ctx, protocol.ProjectRuntimeRequest{RunID: receipt.command.RunID, LeaseEpoch: receipt.command.LeaseEpoch, Operation: "wake_received", Payload: payload}, receipt.loop)
}

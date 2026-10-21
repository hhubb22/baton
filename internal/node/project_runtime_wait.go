package node

import (
	"context"
	"encoding/json"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

const maxProjectThreadBindings = 64

// projectThreadWait 的版本和广播通道由所属进程的 threadMu 保护。
type projectThreadWait struct {
	callID   string
	observed int64
	version  int64
	deadline time.Duration
	changed  chan struct{}
}

type projectThreadCall struct {
	active int
	final  json.RawMessage
}

func (p *projectRuntimeProcess) beginThreadCall(id string) *projectThreadCall {
	if id == "" || len(id) > 128 {
		return nil
	}
	p.threadMu.Lock()
	defer p.threadMu.Unlock()
	if p.threadCalls == nil {
		p.threadCalls = make(map[string]*projectThreadCall)
	}
	call := p.threadCalls[id]
	if call == nil {
		call = &projectThreadCall{}
		p.threadCalls[id] = call
	}
	call.active++
	return call
}

// finishThreadCall 为仍在途的同一调用保留最终响应，避免迟到 pending 重建绑定。
// 最后一条在途响应处理完后即释放该记录。
func (p *projectRuntimeProcess) finishThreadCall(call *projectThreadCall, req protocol.ProjectRuntimeRequest, result protocol.ProjectRuntimeResult, started time.Duration) protocol.ProjectRuntimeResult {
	p.threadMu.Lock()
	defer p.threadMu.Unlock()
	defer func() {
		call.active--
		if call.active == 0 {
			delete(p.threadCalls, req.ToolCallID)
		}
	}()
	if !result.OK {
		return result
	}
	if call.final != nil {
		result.Data = call.final
		return result
	}
	if code := p.rememberThreadWaitLocked(req, result.Data, started); code != "" {
		return projectRuntimeFailure(code)
	}
	var pending struct {
		Pending bool `json:"pending"`
	}
	_ = json.Unmarshal(result.Data, &pending)
	if !pending.Pending {
		call.final = append(json.RawMessage(nil), result.Data...)
	}
	return result
}

// rememberThreadWait 使用请求开始时刻扣除整个往返，保守估算中心剩余等待预算。
func (p *projectRuntimeProcess) rememberThreadWait(req protocol.ProjectRuntimeRequest, data json.RawMessage, started time.Duration) string {
	p.threadMu.Lock()
	defer p.threadMu.Unlock()
	return p.rememberThreadWaitLocked(req, data, started)
}

func (p *projectRuntimeProcess) rememberThreadWaitLocked(req protocol.ProjectRuntimeRequest, data json.RawMessage, started time.Duration) string {
	var pending struct {
		Pending     bool   `json:"pending"`
		ThreadID    string `json:"thread_id"`
		Version     int64  `json:"version"`
		RemainingMS int64  `json:"wait_remaining_ms"`
		Protocol    int    `json:"wait_protocol"`
	}
	if err := json.Unmarshal(data, &pending); err != nil {
		return "unavailable"
	}
	if !pending.Pending {
		for id, thread := range p.threadWaits {
			if thread.callID == req.ToolCallID {
				close(thread.changed)
				delete(p.threadWaits, id)
			}
		}
		return ""
	}
	// 未声明版本等待协议的中心响应由 Runtime 兼容路径处理。
	if pending.Protocol != 1 {
		return ""
	}
	if _, err := identity.ParseUUID(pending.ThreadID); err != nil || req.ToolCallID == "" || len(req.ToolCallID) > 128 || pending.Version < 0 || pending.RemainingMS < 0 || pending.RemainingMS > 600_000 {
		return "unavailable"
	}
	for id, thread := range p.threadWaits {
		if thread.callID == req.ToolCallID && id != pending.ThreadID {
			return "unavailable"
		}
	}
	if p.threadWaits == nil {
		p.threadWaits = make(map[string]*projectThreadWait)
	}
	thread := p.threadWaits[pending.ThreadID]
	if thread == nil {
		if len(p.threadWaits) >= maxProjectThreadBindings {
			return "capacity_exceeded"
		}
		thread = &projectThreadWait{callID: req.ToolCallID, changed: make(chan struct{})}
		p.threadWaits[pending.ThreadID] = thread
	} else if thread.callID != req.ToolCallID {
		return "unavailable"
	}
	thread.observed = max(thread.observed, pending.Version)
	thread.deadline = started + time.Duration(pending.RemainingMS)*time.Millisecond
	if pending.Version > thread.version {
		thread.version = pending.Version
		close(thread.changed)
		thread.changed = make(chan struct{})
	}
	return ""
}

func (p *projectRuntimeProcess) notifyThreadWaits(updates []protocol.ProjectThreadUpdate) {
	p.threadMu.Lock()
	defer p.threadMu.Unlock()
	for _, update := range updates {
		thread := p.threadWaits[update.ThreadID]
		if thread != nil && update.Version > thread.version {
			thread.version = update.Version
			close(thread.changed)
			thread.changed = make(chan struct{})
		}
	}
}

func (m *projectRuntimeManager) pollThreadWake(ctx context.Context, p *projectRuntimeProcess, threadID string, afterVersion int64, wait time.Duration) protocol.ProjectRuntimeResult {
	if _, err := identity.ParseUUID(threadID); err != nil || afterVersion < 0 {
		return projectRuntimeFailure("invalid_request")
	}
	started, err := m.leaseTime(p)
	if err != nil {
		return projectRuntimeFailure("lease_lost")
	}
	deadline := started + wait
	// 定时器只负责唤醒；包含系统休眠的 Mono 负责预算和租约判断。
	timer := time.NewTimer(wait)
	defer timer.Stop()
	check := time.NewTicker(min(time.Second, wait))
	defer check.Stop()
	for {
		now, err := m.leaseTime(p)
		if err != nil {
			return projectRuntimeFailure("lease_lost")
		}
		p.threadMu.Lock()
		thread := p.threadWaits[threadID]
		if thread == nil || afterVersion > thread.observed {
			p.threadMu.Unlock()
			return projectRuntimeFailure("invalid_request")
		}
		version, changed, budget := thread.version, thread.changed, thread.deadline
		p.threadMu.Unlock()
		if version > afterVersion {
			return threadWakeResult("thread_changed", version)
		}
		if now >= budget || now >= deadline {
			return threadWakeResult("timeout", version)
		}
		remaining := min(budget-now, deadline-now)
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(remaining)
		select {
		case <-changed:
		case <-check.C:
		case <-timer.C:
			return threadWakeResult("timeout", version)
		case <-p.done:
			return projectRuntimeFailure("lease_lost")
		case <-ctx.Done():
			return projectRuntimeFailure("unavailable")
		}
	}
}

func threadWakeResult(reason string, version int64) protocol.ProjectRuntimeResult {
	data, _ := protocol.MarshalJSON(struct {
		Reason  string `json:"reason"`
		Version int64  `json:"version"`
	}{reason, version})
	return protocol.ProjectRuntimeResult{Type: protocol.BodyProjectRuntimeResult, OK: true, Data: data}
}

func localWaitCapability(result protocol.ProjectRuntimeResult) protocol.ProjectRuntimeResult {
	var data map[string]json.RawMessage
	if json.Unmarshal(result.Data, &data) != nil || data == nil {
		return projectRuntimeFailure("unavailable")
	}
	data["local_wait_protocol"] = json.RawMessage("1")
	raw, err := protocol.MarshalJSON(data)
	if err != nil || len(raw) > projectRuntimeMaxBytes {
		return projectRuntimeFailure("unavailable")
	}
	result.Data = raw
	return result
}

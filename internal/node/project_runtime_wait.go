package node

import (
	"context"
	"encoding/json"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
)

const maxProjectTaskBindings = 64

// projectTaskWait 的版本和广播通道由所属进程的 taskMu 保护。
type projectTaskWait struct {
	callID   string
	observed int64
	version  int64
	deadline time.Duration
	changed  chan struct{}
}

type projectTaskCall struct {
	active int
	final  json.RawMessage
}

func (p *projectRuntimeProcess) beginTaskCall(id string) *projectTaskCall {
	if id == "" || len(id) > 128 {
		return nil
	}
	p.taskMu.Lock()
	defer p.taskMu.Unlock()
	if p.taskCalls == nil {
		p.taskCalls = make(map[string]*projectTaskCall)
	}
	call := p.taskCalls[id]
	if call == nil {
		call = &projectTaskCall{}
		p.taskCalls[id] = call
	}
	call.active++
	return call
}

// finishTaskCall 为仍在途的同一调用保留最终响应，避免迟到 pending 重建绑定。
// 最后一条在途响应处理完后即释放该记录。
func (p *projectRuntimeProcess) finishTaskCall(call *projectTaskCall, req protocol.ProjectRuntimeRequest, result protocol.ProjectRuntimeResult, started time.Duration) protocol.ProjectRuntimeResult {
	p.taskMu.Lock()
	defer p.taskMu.Unlock()
	defer func() {
		call.active--
		if call.active == 0 {
			delete(p.taskCalls, req.ToolCallID)
		}
	}()
	if !result.OK {
		return result
	}
	if call.final != nil {
		result.Data = call.final
		return result
	}
	if code := p.rememberTaskWaitLocked(req, result.Data, started); code != "" {
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

// rememberTaskWait 使用请求开始时刻扣除整个往返，保守估算中心剩余等待预算。
func (p *projectRuntimeProcess) rememberTaskWait(req protocol.ProjectRuntimeRequest, data json.RawMessage, started time.Duration) string {
	p.taskMu.Lock()
	defer p.taskMu.Unlock()
	return p.rememberTaskWaitLocked(req, data, started)
}

func (p *projectRuntimeProcess) rememberTaskWaitLocked(req protocol.ProjectRuntimeRequest, data json.RawMessage, started time.Duration) string {
	var pending struct {
		Pending     bool   `json:"pending"`
		TaskID      string `json:"task_id"`
		Version     int64  `json:"task_version"`
		RemainingMS int64  `json:"wait_remaining_ms"`
		Protocol    int    `json:"wait_protocol"`
	}
	if err := json.Unmarshal(data, &pending); err != nil {
		return "unavailable"
	}
	if !pending.Pending {
		for id, task := range p.taskWaits {
			if task.callID == req.ToolCallID {
				close(task.changed)
				delete(p.taskWaits, id)
			}
		}
		return ""
	}
	// 旧中心不具备有版本的任务等待协议，继续由 Runtime 兼容路径处理。
	if pending.Protocol != 1 {
		return ""
	}
	if _, err := identity.ParseUUID(pending.TaskID); err != nil || req.ToolCallID == "" || len(req.ToolCallID) > 128 || pending.Version < 0 || pending.RemainingMS < 0 || pending.RemainingMS > 600_000 {
		return "unavailable"
	}
	for id, task := range p.taskWaits {
		if task.callID == req.ToolCallID && id != pending.TaskID {
			return "unavailable"
		}
	}
	if p.taskWaits == nil {
		p.taskWaits = make(map[string]*projectTaskWait)
	}
	task := p.taskWaits[pending.TaskID]
	if task == nil {
		if len(p.taskWaits) >= maxProjectTaskBindings {
			return "capacity_exceeded"
		}
		task = &projectTaskWait{callID: req.ToolCallID, changed: make(chan struct{})}
		p.taskWaits[pending.TaskID] = task
	} else if task.callID != req.ToolCallID {
		return "unavailable"
	}
	task.observed = max(task.observed, pending.Version)
	task.deadline = started + time.Duration(pending.RemainingMS)*time.Millisecond
	if pending.Version > task.version {
		task.version = pending.Version
		close(task.changed)
		task.changed = make(chan struct{})
	}
	return ""
}

func (p *projectRuntimeProcess) notifyTaskWaits(updates []protocol.ProjectTaskUpdate) {
	p.taskMu.Lock()
	defer p.taskMu.Unlock()
	for _, update := range updates {
		task := p.taskWaits[update.TaskID]
		if task != nil && update.Version > task.version {
			task.version = update.Version
			close(task.changed)
			task.changed = make(chan struct{})
		}
	}
}

func (m *projectRuntimeManager) pollTaskWake(ctx context.Context, p *projectRuntimeProcess, taskID string, afterVersion int64, wait time.Duration) protocol.ProjectRuntimeResult {
	if _, err := identity.ParseUUID(taskID); err != nil || afterVersion < 0 {
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
		p.taskMu.Lock()
		task := p.taskWaits[taskID]
		if task == nil || afterVersion > task.observed {
			p.taskMu.Unlock()
			return projectRuntimeFailure("invalid_request")
		}
		version, changed, budget := task.version, task.changed, task.deadline
		p.taskMu.Unlock()
		if version > afterVersion {
			return taskWakeResult("task_changed", version)
		}
		if now >= budget || now >= deadline {
			return taskWakeResult("timeout", version)
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
			return taskWakeResult("timeout", version)
		case <-p.done:
			return projectRuntimeFailure("lease_lost")
		case <-ctx.Done():
			return projectRuntimeFailure("unavailable")
		}
	}
}

func taskWakeResult(reason string, version int64) protocol.ProjectRuntimeResult {
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

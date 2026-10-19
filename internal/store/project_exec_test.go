package store_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func execArgs(h *toolHarness, wait int) map[string]any {
	return map[string]any{"node_id": h.src.NodeID, "command": "printf test", "working_directory": "/registered", "wait_seconds": wait}
}

func TestProjectExecUserRerunBinaryResultRemainsPassive(t *testing.T) {
	h := newToolHarness(t)
	enableExec(t, h)
	req := h.save(t, "nodes.exec", execArgs(h, 600))
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	id := pendingTask(t, out)
	cancelled, err := h.repo.RequestCancel(h.ctx, h.owner, id)
	if err != nil || cancelled.Status != task.StatusCancelled {
		t.Fatal("原命令取消失败", err)
	}
	wait := req
	wait.Operation = "wait_tool"
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil {
		t.Fatal(err)
	}
	h.seq = out.(projectagent.Event).Seq
	rerun, err := h.repo.RerunTask(h.ctx, h.owner, id, task.RerunInput{RequestID: "rerun-shell-binary", ExpectedVersion: cancelled.Version, Reason: "用户要求新执行"})
	if err != nil || rerun.AgentType != "shell" || rerun.ProjectID == nil || *rerun.ProjectID != h.project.ID || rerun.OriginConversationID != nil {
		t.Fatalf("用户重做没有保留命令与 Project 来源：%+v %v", rerun, err)
	}
	claim := h.req
	claim.Operation, claim.LastSeq = "claim_inputs", h.seq
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || out.(projectagent.Claim).Event == nil {
		t.Fatal("未读取原命令的新执行通知", err)
	}
	h.seq = out.(projectagent.Claim).Event.Seq
	finish := h.req
	finish.Operation, finish.LastSeq = "append_event", h.seq
	finish.ClientEventID = "rerun-notice-processed"
	finish.Payload = json.RawMessage(`{"format":"pi-ai/1","message":{"role":"assistant","content":[{"type":"text","text":"已记录用户的新执行"}]}}`)
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, finish)
	if err != nil {
		t.Fatal(err)
	}
	finish.Operation, finish.LastSeq, finish.Payload = "finish", out.(projectagent.Event).Seq, nil
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, finish); err != nil {
		t.Fatal(err)
	}
	intent, ok, err := h.repo.ClaimPrepare(h.ctx, 5*time.Second)
	if err != nil || !ok || intent.TaskID != rerun.TaskID {
		t.Fatalf("未准备用户的新命令：%+v %v", intent, err)
	}
	sessionID, generation := mustUUID(t), mustUUID(t)
	if err = h.repo.SavePrepared(h.ctx, store.PreparedFact{MessageID: intent.MessageID, EmployeeID: h.owner, NodeID: h.src.NodeID, TaskID: rerun.TaskID, ExecutionID: intent.ExecutionID, SessionID: sessionID, StorageGeneration: generation}); err != nil {
		t.Fatal(err)
	}
	start := store.StartRequest{EmployeeID: h.owner, NodeID: h.src.NodeID, CredentialID: h.src.CredentialID, TaskID: rerun.TaskID, ExecutionID: intent.ExecutionID, SessionID: sessionID, StorageGeneration: generation, Nonce: mustUUID(t)}
	if decision, err := h.repo.AuthorizeStart(h.ctx, start); err != nil || !decision.Issue {
		t.Fatalf("用户新命令没有取得许可：%+v %v", decision, err)
	}
	retained := bytes.Repeat([]byte{0, 1, 0xff, '\\'}, task.CommandOutputBytes/4)
	report := completedReport(start, mustUUID(t))
	report.CommandResult = &task.CommandResult{Encoding: "base64", Output: base64.StdEncoding.EncodeToString(retained), TotalBytes: task.CommandOutputBytes}
	if ack, code, err := h.repo.ApplyExecutionReport(h.ctx, report); err != nil || !ack {
		t.Fatalf("用户命令的二进制终态无法保存：%s %v", code, err)
	}
	completed, err := h.repo.GetTask(h.ctx, h.owner, rerun.TaskID)
	if err != nil || completed.Status != task.StatusCompleted || completed.CommandResult == nil {
		t.Fatal("用户命令没有保存完整终态", err)
	}
	var kind string
	var raw []byte
	if err = h.pool.QueryRow(h.ctx, `SELECT source_type,payload FROM project_agent_input_queue WHERE agent_id=$1 AND source_key=$2`, h.project.Agent.ID, fmt.Sprintf("task:%s:result:%d", rerun.TaskID, completed.Version)).Scan(&kind, &raw); err != nil {
		t.Fatal(err)
	}
	var notification store.ProjectTaskResultInput
	if err = json.Unmarshal(raw, &notification); err != nil || kind != "user_task_result" || !notification.NotificationOnly || notification.CommandResult == nil {
		t.Fatalf("用户命令结果没有保留被动来源：%s %v", kind, err)
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(notification.CommandResult.Output)
	if err != nil || !bytes.Equal(decoded, retained) {
		t.Fatal("被动通知丢失二进制输出", err)
	}
	if err = h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	var runs int
	if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM agent_runs WHERE agent_id=$1`, h.project.Agent.ID).Scan(&runs); err != nil || runs != 1 {
		t.Fatal("被动命令结果启动了新 Runtime", runs, err)
	}
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "read-rerun-output", "读取用户新命令的结果")
	if err = h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	claim = runtimeRequest(t, h.ctx, h.pool, h.project.Agent.ID, "claim_inputs")
	claim.LastSeq = finish.LastSeq
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || out.(projectagent.Claim).InputCount != 2 || !strings.Contains(string(out.(projectagent.Claim).Event.Payload), report.CommandResult.Output) {
		t.Fatal("主动消息未带回完整用户命令结果", err)
	}
	claim.LastSeq = out.(projectagent.Claim).Event.Seq
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || out.(projectagent.Claim).Event != nil {
		t.Fatal("用户命令结果重复投递", err)
	}
}

func TestProjectExecWaitCarriesUserOperation(t *testing.T) {
	for _, action := range []string{"cancel", "resolve"} {
		t.Run(action, func(t *testing.T) {
			h := newToolHarness(t)
			enableExec(t, h)
			req := h.save(t, "nodes.exec", execArgs(h, 600))
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
			if err != nil {
				t.Fatal(err)
			}
			id := pendingTask(t, out)
			if action == "cancel" {
				_, err = h.repo.RequestCancel(h.ctx, h.owner, id)
			} else {
				if _, err = h.pool.Exec(h.ctx, `UPDATE tasks SET status='needs_verification',version=version+1 WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
				_, err = h.repo.ResolveTask(h.ctx, h.owner, id, task.ResolveInput{ExpectedVersion: 2, Status: task.StatusCompleted, Summary: "用户核实命令已完成", Reason: "已检查节点", EvidenceEmptyReason: "用户检查"})
			}
			if err != nil {
				t.Fatal(err)
			}
			wait := req
			wait.Operation = "wait_tool"
			out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
			if err != nil {
				t.Fatal(err)
			}
			event := out.(projectagent.Event)
			text, _ := toolText(t, event)
			var result struct {
				Version   int64 `json:"version"`
				Operation struct {
					Employee string `json:"employee_id"`
					Actor    string `json:"actor"`
					Action   string `json:"action"`
				} `json:"user_operation"`
			}
			if err = json.Unmarshal(text, &result); err != nil || result.Operation.Employee != h.owner || result.Operation.Actor != "user" || result.Operation.Action != action {
				t.Fatalf("同步结果丢失用户操作：%s %v", text, err)
			}
			var delivered *int64
			if err = h.pool.QueryRow(h.ctx, `SELECT delivered_seq FROM project_agent_input_queue WHERE agent_id=$1 AND source_key=$2`, h.project.Agent.ID, fmt.Sprintf("task:%s:result:%d", id, result.Version)).Scan(&delivered); err != nil || delivered == nil || *delivered != event.Seq {
				t.Fatal("包含用户操作的结果通知未标为已投递", err)
			}
			claim := h.req
			claim.Operation, claim.LastSeq = "claim_inputs", event.Seq
			out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim)
			if err != nil || out.(projectagent.Claim).Event != nil {
				t.Fatal("已同步返回的用户操作再次作为输入投递", err)
			}
		})
	}
}

func TestProjectExecPublicTaskCannotBypassConversation(t *testing.T) {
	h := newToolHarness(t)
	enableExec(t, h)
	if _, err := h.pool.Exec(h.ctx, `UPDATE nodes SET capabilities=array_append(capabilities,'shell'),default_agent_type='shell' WHERE id=$1`, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	shell := "shell"
	for _, agent := range []*string{&shell, nil} {
		input := task.Input{
			RequestID: fmt.Sprintf("public-shell-%t", agent == nil), Description: "printf unaudited",
			TargetNodeID: &h.src.NodeID, AgentType: agent,
		}
		_, err := h.repo.AcceptTask(h.ctx, h.owner, input)
		var rejection *task.Rejection
		if !errors.As(err, &rejection) || rejection.Code != task.CodeUnsupported {
			t.Fatalf("公共任务接口接受命令任务，默认Agent=%t：%v", agent == nil, err)
		}
	}
	var tasks int
	if err := h.pool.QueryRow(h.ctx, `SELECT count(*) FROM tasks WHERE employee_id=$1`, h.owner).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatal("被拒绝的公共命令产生任务", tasks, err)
	}
}

func TestProjectExecBinaryResultWaitAndReplay(t *testing.T) {
	h := newToolHarness(t)
	enableExec(t, h)
	req := h.save(t, "nodes.exec", execArgs(h, 600))
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	id := pendingTask(t, out)
	retained := bytes.Repeat([]byte{0, 1, 0xff, '\\'}, task.CommandOutputBytes/4)
	command := &task.CommandResult{
		Encoding: "base64", Output: base64.StdEncoding.EncodeToString(retained),
		TotalBytes: 40 << 10, ExitCode: 0, Truncated: true,
	}
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	if _, err = tx.Exec(h.ctx, `UPDATE tasks SET status='completed',version=version+1,summary='完成',command_result=$2 WHERE id=$1`, id, command); err != nil {
		t.Fatal(err)
	}
	if err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, store.ProjectTaskResultInput{TaskID: id, Version: 2, Status: task.StatusCompleted, Text: "完成", CommandResult: command}); err != nil {
		t.Fatal("二进制输出无法保存到结果队列", err)
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	wait := req
	wait.Operation = "wait_tool"
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil {
		t.Fatal(err)
	}
	event := out.(projectagent.Event)
	var payload struct {
		Message struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err = json.Unmarshal(event.Payload, &payload); err != nil || payload.Message.IsError || len(payload.Message.Content) != 1 {
		t.Fatal("命令工具结果无效", err)
	}
	var result struct {
		TaskID  string             `json:"task_id"`
		Status  string             `json:"status"`
		Command task.CommandResult `json:"command_result"`
	}
	if err = json.Unmarshal([]byte(payload.Message.Content[0].Text), &result); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(result.Command.Output)
	if err != nil || !bytes.Equal(decoded, retained) || result.Command.Encoding != "base64" || result.Command.TotalBytes != 40<<10 || !result.Command.Truncated || result.TaskID != id || result.Status != task.StatusCompleted {
		t.Fatal("二进制输出或退出事实丢失", err)
	}
	wire, err := protocol.MarshalJSON(event)
	if err != nil || len(event.Payload) > projectagent.MaxEventBytes || len(wire) > protocol.MaxProjectRuntimeBytes-2048 {
		t.Fatal("二进制工具结果超过事件或传输容量", err)
	}
	var delivered *int64
	if err = h.pool.QueryRow(h.ctx, `SELECT delivered_seq FROM project_agent_input_queue WHERE agent_id=$1 AND source_key=$2`, h.project.Agent.ID, fmt.Sprintf("task:%s:result:2", id)).Scan(&delivered); err != nil || delivered == nil || *delivered != event.Seq {
		t.Fatal("同步返回后未标记原通知已投递", err)
	}
	replayed, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || replayed.(projectagent.Event).Seq != event.Seq || !bytes.Equal(replayed.(projectagent.Event).Payload, event.Payload) {
		t.Fatal("重试工具调用改变了已保存结果", err)
	}
	claim := h.req
	claim.Operation, claim.LastSeq = "claim_inputs", event.Seq
	next, err := h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || next.(projectagent.Claim).Event != nil {
		t.Fatal("同步返回后重复领取命令结果", err)
	}
}

func TestProjectExecNeedsVerificationEndsWait(t *testing.T) {
	h := newToolHarness(t)
	enableExec(t, h)
	req := h.save(t, "nodes.exec", execArgs(h, 600))
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	id := pendingTask(t, out)
	if _, err = h.pool.Exec(h.ctx, `UPDATE tasks SET status='needs_verification',error_code=$2,version=version+1 WHERE id=$1`, id, task.CodeUncertainWorker); err != nil {
		t.Fatal(err)
	}
	wait := req
	wait.Operation = "wait_tool"
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil {
		t.Fatal(err)
	}
	event, ok := out.(projectagent.Event)
	if !ok || event.Kind != "tool_result" {
		t.Fatalf("待核实任务仍在等待：%+v", out)
	}
	text, isError := toolText(t, event)
	var result struct {
		TaskID  string `json:"task_id"`
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if err = json.Unmarshal(text, &result); err != nil || isError || result.TaskID != id || result.Status != task.StatusNeedsVerification || !strings.Contains(result.Message, "不会自动重试") || strings.Contains(result.Message, "仍在执行") {
		t.Fatal("待核实结果没有明确说明状态", string(text), err)
	}
	var unexpired bool
	var status string
	var executions int
	if err = h.pool.QueryRow(h.ctx, `SELECT exec_wait_until>clock_timestamp(),status,(SELECT count(*) FROM executions WHERE task_id=$1) FROM tasks WHERE id=$1`, id).Scan(&unexpired, &status, &executions); err != nil || !unexpired || status != task.StatusNeedsVerification || executions != 1 {
		t.Fatal("等待结束后任务状态或执行次数变化", status, executions, err)
	}
	replayed, err := h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil || replayed.(projectagent.Event).Seq != event.Seq {
		t.Fatal("待核实结果重复写入", err)
	}
}
func enableExec(t *testing.T, h *toolHarness) {
	t.Helper()
	_, err := h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(report,'{exec,enabled}','true') WHERE node_id=$1`, h.src.NodeID)
	if err != nil {
		t.Fatal(err)
	}
}
func pendingTask(t *testing.T, out any) string {
	t.Helper()
	raw, _ := json.Marshal(out)
	var p struct {
		Pending bool   `json:"pending"`
		TaskID  string `json:"task_id"`
	}
	if json.Unmarshal(raw, &p) != nil || !p.Pending || p.TaskID == "" {
		t.Fatalf("没有返回等待任务：%s", raw)
	}
	return p.TaskID
}
func TestProjectExecParametersAndIdempotentRecovery(t *testing.T) {
	h := newToolHarness(t)
	if _, bad := h.call(t, "nodes.exec", execArgs(h, 30)); !bad {
		t.Fatal("未开启仍接受命令")
	}
	enableExec(t, h)
	for _, wait := range []int{-1, 601} {
		if _, bad := h.call(t, "nodes.exec", execArgs(h, wait)); !bad {
			t.Fatal("接受无效等待时间")
		}
	}
	req := h.save(t, "nodes.exec", execArgs(h, 600))
	// 事务提交失败必须同时撤销任务与等待记录。
	h.repo.SetTaskCommitHook(func(_ctx context.Context) error { return errors.New("injected") })
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err == nil {
		t.Fatal("注入失败未生效")
	}
	h.repo.SetTaskCommitHook(nil)
	var n int
	if err := h.pool.QueryRow(h.ctx, `SELECT count(*) FROM tasks WHERE project_id=$1`, h.project.ID).Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	id := pendingTask(t, out)
	// 能力关闭后仍只能恢复原任务；不能重新接受或重置等待截止时间。
	_, err = h.pool.Exec(h.ctx, `UPDATE node_runtime_reports SET report=jsonb_set(report,'{exec,enabled}','false') WHERE node_id=$1`, h.src.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || pendingTask(t, out) != id {
		t.Fatal(err)
	}
	var timeout, executions int
	if err = h.pool.QueryRow(h.ctx, `SELECT execution_timeout_seconds,(SELECT count(*) FROM executions WHERE task_id=$1) FROM tasks WHERE id=$1`, id).Scan(&timeout, &executions); err != nil || timeout != 7200 || executions != 1 {
		t.Fatal(timeout, executions, err)
	}
	wait := req
	wait.Operation = "wait_tool"
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil || pendingTask(t, out) != id {
		t.Fatal(err)
	}
	wait.Payload = json.RawMessage(`{"finish_wait":true}`)
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
	if err != nil {
		t.Fatal(err)
	}
	e := out.(projectagent.Event)
	if !strings.Contains(string(e.Payload), "仍在执行") {
		t.Fatal(string(e.Payload))
	}
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, wait); err != nil {
		t.Fatal("重发结果不幂等", err)
	}
}

func TestProjectExecWaitDeadlineTerminalRace(t *testing.T) {
	// 并发提交任务终态和等待截止；同一结果只能在工具返回或新输入中投递一次。
	for i := 0; i < 12; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			h := newToolHarness(t)
			enableExec(t, h)
			req := h.save(t, "nodes.exec", execArgs(h, 0))
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
			if err != nil {
				t.Fatal(err)
			}
			id := pendingTask(t, out)
			command := &task.CommandResult{Output: strings.Repeat("x", 32<<10), TotalBytes: 32 << 10, ExitCode: 0}
			var wg sync.WaitGroup
			errs := make(chan error, 2)
			wg.Add(1)
			go func() {
				defer wg.Done()
				tx, err := h.pool.Begin(h.ctx)
				if err != nil {
					errs <- err
					return
				}
				defer tx.Rollback(h.ctx)
				_, err = tx.Exec(h.ctx, `UPDATE tasks SET status='completed',version=version+1,summary='完成',command_result=$2 WHERE id=$1`, id, command)
				if err == nil {
					err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, store.ProjectTaskResultInput{TaskID: id, Version: 2, Status: "completed", Text: "完成", CommandResult: command})
				}
				if err == nil {
					err = tx.Commit(h.ctx)
				}
				errs <- err
			}()
			wait := req
			wait.Operation = "wait_tool"
			out, err = h.repo.ProjectRuntime(h.ctx, h.src, wait)
			if err != nil {
				t.Fatal(err)
			}
			e := out.(projectagent.Event)
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatal(err)
				}
			}
			var delivered *int64
			var count int
			if err = h.pool.QueryRow(h.ctx, `SELECT count(*),min(delivered_seq) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='task_result'`, h.project.Agent.ID).Scan(&count, &delivered); err != nil || count != 1 {
				t.Fatal(count, err)
			}
			returned := strings.Contains(string(e.Payload), "command_result")
			if returned != (delivered != nil) || (delivered != nil && *delivered != e.Seq) {
				t.Fatal("同一结果重复或遗漏", returned, delivered, e.Seq)
			}
			if returned && !strings.Contains(string(e.Payload), strings.Repeat("x", 32<<10)) {
				t.Fatal("命令输出被截断")
			}
		})
	}
}

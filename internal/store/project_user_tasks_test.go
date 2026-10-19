package store_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/store"
	"baton/internal/task"
)

func TestProjectUserTaskNotificationAndOwnership(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	setDefaultAgent(t, ctx, pool, src.NodeID, "codex")
	input := task.Input{ProjectID: &p.ID, RequestID: "user-task", Description: "用户派发"}
	rec, err := repo.AcceptTask(ctx, owner, input)
	if err != nil || rec.ProjectID == nil || *rec.ProjectID != p.ID || rec.TargetNodeID != src.NodeID {
		t.Fatalf("默认值和 Project: %+v %v", rec, err)
	}
	replay, err := repo.AcceptTask(ctx, owner, input)
	if err != nil || replay.TaskID != rec.TaskID {
		t.Fatal("请求重发", err)
	}
	otherEmployee := mustEmployee(t, ctx, pool, "foreign", "其他员工")
	foreign, err := repo.CreateProject(ctx, otherEmployee.ID, projectagent.CreateInput{Title: "其他项目"})
	if err != nil {
		t.Fatal(err)
	}
	other := foreign.ID
	input.ProjectID = &other
	if _, err = repo.AcceptTask(ctx, owner, input); err == nil {
		t.Fatal("相同请求改变 Project 未冲突")
	}
	input.RequestID = "foreign-project"
	if _, err = repo.AcceptTask(ctx, owner, input); !errors.Is(err, store.ErrNotVisible) {
		t.Fatal("接受未知 Project", err)
	}
	if _, err = repo.RequestCancel(ctx, owner, rec.TaskID); err != nil {
		t.Fatal(err)
	}
	if err = repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_runs WHERE agent_id=$1`, p.Agent.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("通知触发运行 %d %v", count, err)
	}
	var kind string
	var raw []byte
	if err = pool.QueryRow(ctx, `SELECT source_type,payload FROM project_agent_input_queue WHERE agent_id=$1`, p.Agent.ID).Scan(&kind, &raw); err != nil || kind != "user_task_result" || !strings.Contains(string(raw), `"notification_only": true`) {
		t.Fatalf("结果通知 %s %s %v", kind, raw, err)
	}
	acceptProjectInput(t, ctx, repo, owner, p.ID, "read-results", "读取任务结果")
	if err = repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
	result, err := repo.ProjectRuntime(ctx, src, req)
	if err != nil || result.(projectagent.Claim).InputCount != 2 {
		t.Fatalf("通知和消息领取 %+v %v", result, err)
	}
	req.LastSeq = result.(projectagent.Claim).Event.Seq
	result, err = repo.ProjectRuntime(ctx, src, req)
	if err != nil || result.(projectagent.Claim).Event != nil {
		t.Fatal("重复领取", err)
	}
	page, err := repo.ListTaskViews(ctx, owner, store.TaskFilter{ProjectID: p.ID})
	if err != nil || len(page.Tasks) != 1 || page.Tasks[0].OriginConversationID != nil {
		t.Fatal("用户来源和列表", err)
	}
}

func TestProjectPausedUserResolveAndRerunInputs(t *testing.T) {
	h := newToolHarness(t)
	id := h.dispatch(t)
	status := "paused"
	if _, err := h.repo.PatchProject(h.ctx, h.owner, h.project.ID, projectagent.Patch{Status: &status}); err != nil {
		t.Fatal(err)
	}
	setDefaultAgent(t, h.ctx, h.pool, h.src.NodeID, "codex")
	direct, err := h.repo.AcceptTask(h.ctx, h.owner, task.Input{ProjectID: &h.project.ID, RequestID: "paused-task", Description: "暂停时派发"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.repo.RequestCancel(h.ctx, h.owner, id); err != nil {
		t.Fatal(err)
	}
	original, err := h.repo.GetTask(h.ctx, h.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := h.repo.ResolveTask(h.ctx, h.owner, id, task.ResolveInput{ExpectedVersion: original.Version, Status: "completed", Summary: "人工核实完成", Reason: "用户检查", EvidenceEmptyReason: "人工核实"})
	if err != nil {
		t.Fatal(err)
	}
	rerunInput := task.RerunInput{RequestID: "user-rerun", ExpectedVersion: resolved.Version, Reason: "用户要求重新执行"}
	rerun, err := h.repo.RerunTask(h.ctx, h.owner, id, rerunInput)
	if err != nil || rerun.ProjectID == nil || *rerun.ProjectID != h.project.ID || rerun.OriginConversationID != nil {
		t.Fatalf("新执行 Project 和用户来源 %+v %v", rerun, err)
	}
	again, err := h.repo.RerunTask(h.ctx, h.owner, id, rerunInput)
	if err != nil || again.TaskID != rerun.TaskID {
		t.Fatal("新执行重发", err)
	}
	if _, err = h.repo.RequestCancel(h.ctx, h.owner, direct.TaskID); err != nil {
		t.Fatal(err)
	}
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "paused-message", "恢复后处理")
	if err = h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	var active int
	if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM agent_runs WHERE agent_id=$1 AND ended_at IS NULL`, h.project.Agent.ID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("暂停时有运行 %d %v", active, err)
	}
	status = "active"
	if _, err = h.repo.PatchProject(h.ctx, h.owner, h.project.ID, projectagent.Patch{Status: &status}); err != nil {
		t.Fatal(err)
	}
	if err = h.repo.ScheduleProjectRuns(h.ctx); err != nil {
		t.Fatal(err)
	}
	req := runtimeRequest(t, h.ctx, h.pool, h.project.Agent.ID, "claim_inputs")
	req.LastSeq = h.seq
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	claim := out.(projectagent.Claim)
	if claim.InputCount != 5 {
		t.Fatalf("应领取取消、核实、新执行、用户结果和消息，得到 %d", claim.InputCount)
	}
	for _, action := range []string{"cancel", "resolve", "rerun"} {
		if !strings.Contains(string(claim.Event.Payload), action) {
			t.Fatal("缺少用户操作", action)
		}
	}
	if !strings.Contains(string(claim.Event.Payload), h.owner) {
		t.Fatal("缺少操作人")
	}
	req.LastSeq = claim.Event.Seq
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || out.(projectagent.Claim).Event != nil {
		t.Fatal("恢复后重复领取", err)
	}
}

func TestProjectUserCancelRunningTaskCarriesActor(t *testing.T) {
	for _, user := range []bool{true, false} {
		t.Run(fmt.Sprint(user), func(t *testing.T) {
			ctx, repo, pool, in, _ := preparedStart(t)
			p, err := repo.CreateProject(ctx, in.EmployeeID, projectagent.CreateInput{Title: "运行中取消"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = pool.Exec(ctx, `UPDATE tasks SET project_id=$2,origin_conversation_id=$3,origin_tool_call_id='test-dispatch' WHERE id=$1`, in.TaskID, p.ID, p.Conversation.ID); err != nil {
				t.Fatal(err)
			}
			if d, err := repo.AuthorizeStart(ctx, in); err != nil || !d.Issue {
				t.Fatalf("启动许可 %+v %v", d, err)
			}
			started := startedReport(in, mustUUID(t))
			if ack, _, err := repo.ApplyExecutionReport(ctx, started); err != nil || !ack {
				t.Fatal(err)
			}
			cancel := func() (store.CancelDecision, error) {
				if user {
					return repo.RequestCancel(ctx, in.EmployeeID, in.TaskID)
				}
				return repo.RequestAgentCancel(ctx, store.AgentSource{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, SessionID: in.SessionID, ExecutionID: in.ExecutionID}, in.TaskID)
			}
			if d, err := cancel(); err != nil || d.Status != task.StatusNeedsVerification || !d.PossibleStart {
				t.Fatalf("取消待确认 %+v %v", d, err)
			}
			report := store.ExecutionReport{EmployeeID: in.EmployeeID, NodeID: in.NodeID, TaskID: in.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID, EventID: mustUUID(t), Kind: task.EventStopReport, Status: task.StatusNeedsVerification, StopReason: task.StatusCancelled, OccurredAt: time.Now().UTC(), AgentStopped: true, OutcomeKnown: true, WorkerSequence: 2}
			for range 2 {
				if ack, _, err := repo.ApplyExecutionReport(ctx, report); err != nil || !ack {
					t.Fatal(err)
				}
			}
			var count int
			var actor, action, kind string
			if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1`, p.Agent.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("终态重复 %d %v", count, err)
			}
			if err = pool.QueryRow(ctx, `SELECT source_type,COALESCE(payload->'user_operation'->>'employee_id',''),COALESCE(payload->'user_operation'->>'action','') FROM project_agent_input_queue WHERE agent_id=$1`, p.Agent.ID).Scan(&kind, &actor, &action); err != nil || kind != "task_result" || (user && (actor != in.EmployeeID || action != "cancel")) || (!user && (actor != "" || action != "")) {
				t.Fatalf("操作来源 %s %s %s %v", kind, actor, action, err)
			}
			rec, err := repo.GetTask(ctx, in.EmployeeID, in.TaskID)
			if err != nil || rec.Status != task.StatusCancelled || rec.StopConfirmedAt == nil {
				t.Fatalf("停止确认 %+v %v", rec, err)
			}
		})
	}
}

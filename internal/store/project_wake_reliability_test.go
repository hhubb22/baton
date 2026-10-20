package store_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
)

func TestProjectRunWakeTaskVersionsRotateAndReplayCommittedInputs(t *testing.T) {
	h := newToolHarness(t)
	started := h.req
	started.Operation = "started"
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, started); err != nil {
		t.Fatal(err)
	}
	// 保留较早分配、较晚提交的输入，验证提示不使用 queue MAX(id) 确认交付。
	late, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer late.Rollback(h.ctx)
	lateID := mustUUID(t)
	if err = store.EnqueueProjectTaskResult(h.ctx, late, h.owner, h.project.Agent.ID, store.ProjectTaskResultInput{TaskID: lateID, Version: 8, Status: task.StatusCompleted}); err != nil {
		t.Fatal(err)
	}
	expected := make(map[string]int64)
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	for range 70 {
		id := mustUUID(t)
		expected[id] = 9
		for _, version := range []int64{4, 9, 9} {
			if err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, store.ProjectTaskResultInput{TaskID: id, Version: version, Status: task.StatusCompleted}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]int)
	scan := func() []protocol.ProjectTaskUpdate {
		t.Helper()
		commands, err := h.repo.ProjectRunCommands(h.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(commands) != 1 || commands[0].Command.Type != protocol.BodyProjectRunWake {
			t.Fatalf("缺少 wake: %+v", commands)
		}
		c := commands[0].Command
		if len(c.TaskUpdates) > 32 {
			t.Fatalf("任务提示超过32: %d", len(c.TaskUpdates))
		}
		raw, err := protocol.MarshalJSON(c)
		if err != nil || len(raw) > protocol.MaxProjectRuntimeBytes-1024 {
			t.Fatal("wake 编码超过容量", err)
		}
		unique := map[string]bool{}
		for _, u := range c.TaskUpdates {
			if unique[u.TaskID] || expected[u.TaskID] != u.Version {
				t.Fatalf("版本或任务去重错误: %+v", u)
			}
			unique[u.TaskID] = true
			seen[u.TaskID]++
		}
		return c.TaskUpdates
	}
	first := scan()
	if len(first) != 32 || seen[lateID] != 0 {
		t.Fatal("读取未提交输入或未填充有界批次")
	}
	if err = late.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	expected[lateID] = 8
	for range 7 {
		scan()
	}
	if len(seen) != len(expected) {
		t.Fatalf("后页任务或晚提交输入饥饿: seen=%d want=%d", len(seen), len(expected))
	}
	for id, n := range seen {
		if n < 2 {
			t.Fatalf("未交付输入没有安全重发: %s count=%d", id, n)
		}
	}
	var delivered int
	if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='task_result' AND delivered_seq IS NOT NULL`, h.project.Agent.ID).Scan(&delivered); err != nil || delivered != 0 {
		t.Fatal("发送提示确认了输入交付", delivered, err)
	}
	// 逐条确认后停止任务提示，用户输入仍可触发通用 wake。
	if _, err = h.pool.Exec(h.ctx, `UPDATE project_agent_input_queue SET delivered_seq=$2 WHERE agent_id=$1 AND source_type='task_result'`, h.project.Agent.ID, h.seq); err != nil {
		t.Fatal(err)
	}
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "generic-wake", "普通消息")
	if updates := scan(); len(updates) != 0 {
		t.Fatal("已交付输入仍产生任务提示", updates)
	}
}

func TestProjectExecNeedsVerificationWithoutOutputQueuesAtomically(t *testing.T) {
	for _, transition := range []string{"report", "cancel"} {
		t.Run(transition, func(t *testing.T) {
			h, req, p := execWaitFixture(t, 600)
			var in store.StartRequest
			var messageID string
			if err := h.pool.QueryRow(h.ctx, `SELECT e.id::text,o.id::text FROM executions e JOIN dispatch_outbox o ON o.execution_id=e.id WHERE e.task_id=$1`, p.TaskID).Scan(&in.ExecutionID, &messageID); err != nil {
				t.Fatal(err)
			}
			in.EmployeeID, in.NodeID, in.CredentialID, in.TaskID = h.owner, h.src.NodeID, h.src.CredentialID, p.TaskID
			in.SessionID, in.StorageGeneration, in.Nonce = mustUUID(t), mustUUID(t), mustUUID(t)
			if err := h.repo.SavePrepared(h.ctx, store.PreparedFact{MessageID: messageID, EmployeeID: h.owner, NodeID: h.src.NodeID, TaskID: p.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID, StorageGeneration: in.StorageGeneration}); err != nil {
				t.Fatal(err)
			}
			if decision, err := h.repo.AuthorizeStart(h.ctx, in); err != nil || !decision.Issue {
				t.Fatal("未发出启动许可", decision, err)
			}
			report := store.ExecutionReport{EmployeeID: h.owner, NodeID: h.src.NodeID, TaskID: p.TaskID, ExecutionID: in.ExecutionID, SessionID: in.SessionID, EventID: mustUUID(t), Kind: task.EventNeedsVerification, Status: task.StatusNeedsVerification, ErrorCode: task.CodeUncertainWorker}
			change := func() error {
				if transition == "cancel" {
					_, err := h.repo.RequestCancel(h.ctx, h.owner, p.TaskID)
					return err
				}
				ack, code, err := h.repo.ApplyExecutionReport(h.ctx, report)
				if err == nil && !ack {
					return fmt.Errorf("报告未确认: %s", code)
				}
				return err
			}
			if _, err := h.pool.Exec(h.ctx, `CREATE FUNCTION reject_task_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected input failure'; END $$; CREATE TRIGGER reject_task_input BEFORE INSERT ON project_agent_input_queue FOR EACH ROW EXECUTE FUNCTION reject_task_input()`); err != nil {
				t.Fatal(err)
			}
			if err := change(); err == nil {
				t.Fatal("队列写入失败仍提交了状态")
			}
			before, err := h.repo.GetTask(h.ctx, h.owner, p.TaskID)
			if err != nil || before.Status == task.StatusNeedsVerification {
				t.Fatal("队列失败未回滚待核实状态", err)
			}
			if _, err = h.pool.Exec(h.ctx, `DROP TRIGGER reject_task_input ON project_agent_input_queue; DROP FUNCTION reject_task_input()`); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if err = change(); err != nil {
					t.Fatal(err)
				}
			}
			current, err := h.repo.GetTask(h.ctx, h.owner, p.TaskID)
			if err != nil || current.Status != task.StatusNeedsVerification || current.CommandResult != nil {
				t.Fatal("待核实无输出状态错误", err)
			}
			var count int
			if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='task_result'`, h.project.Agent.ID).Scan(&count); err != nil || count != 1 {
				t.Fatal("重复报告或取消重复生成输入", count, err)
			}
			var payload []byte
			if err = h.pool.QueryRow(h.ctx, `SELECT payload FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='task_result'`, h.project.Agent.ID).Scan(&payload); err != nil {
				t.Fatal(err)
			}
			var input store.ProjectTaskResultInput
			if err = json.Unmarshal(payload, &input); err != nil || input.TaskID != p.TaskID || input.Version != int64(current.Version) || input.Status != task.StatusNeedsVerification || input.CommandResult != nil {
				t.Fatal("状态输入丢失任务或版本", string(payload), err)
			}
			started := req
			started.Operation = "started"
			if _, err = h.repo.ProjectRuntime(h.ctx, h.src, started); err != nil {
				t.Fatal(err)
			}
			commands, err := h.repo.ProjectRunCommands(h.ctx)
			if err != nil || len(commands) != 1 || len(commands[0].Command.TaskUpdates) != 1 || commands[0].Command.TaskUpdates[0].Version != int64(current.Version) {
				t.Fatal("待核实没有版本提示", commands, err)
			}
			req.Operation = "wait_tool"
			out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
			if err != nil {
				t.Fatal(err)
			}
			e := out.(projectagent.Event)
			var delivered *int64
			if err = h.pool.QueryRow(h.ctx, `SELECT delivered_seq FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='task_result'`, h.project.Agent.ID).Scan(&delivered); err != nil || delivered == nil || *delivered != e.Seq {
				t.Fatal("待核实同步结果没有确认对应输入", err)
			}
			claim := h.req
			claim.Operation, claim.LastSeq = "claim_inputs", e.Seq
			out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim)
			if err != nil || out.(projectagent.Claim).Event != nil {
				t.Fatal("同步待核实结果重复交付", err)
			}
		})
	}
}

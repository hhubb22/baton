package store_test

import (
	"encoding/json"
	"strings"
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
	versions := make(map[string]int64)
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
		if len(c.InputIDs) == 0 || len(c.InputIDs) > 32 || len(c.TaskUpdates) > 32 {
			t.Fatalf("任务提示超过32: %d", len(c.TaskUpdates))
		}
		raw, err := protocol.MarshalJSON(c)
		if err != nil || len(raw) > protocol.MaxProjectRuntimeBytes-1024 {
			t.Fatal("wake 编码超过容量", err)
		}
		unique := map[string]bool{}
		for _, u := range c.TaskUpdates {
			if unique[u.TaskID] || u.Version < 1 || expected[u.TaskID] < u.Version {
				t.Fatalf("版本或任务去重错误: %+v", u)
			}
			unique[u.TaskID] = true
			seen[u.TaskID]++
			versions[u.TaskID] = max(versions[u.TaskID], u.Version)
		}
		return c.TaskUpdates
	}
	first := scan()
	if len(first) != 16 || seen[lateID] != 0 {
		t.Fatal("读取未提交输入或未填充有界批次")
	}
	if err = late.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	expected[lateID] = 8
	// 先让每个仍到期的输入获得机会，再推进数据库中的重试时间。
	for range 4 {
		scan()
	}
	if _, err = h.pool.Exec(h.ctx, "UPDATE project_agent_input_queue SET wake_next_at=clock_timestamp()-interval '1 second' WHERE agent_id=$1", h.project.Agent.ID); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		scan()
	}
	if len(seen) != len(expected) {
		t.Fatalf("后页任务或晚提交输入饥饿: seen=%d want=%d", len(seen), len(expected))
	}
	for id, n := range seen {
		if n < 2 || versions[id] != expected[id] {
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

func TestProjectRunWakeThreadUpdatesAreSortedBoundedAndCurrent(t *testing.T) {
	h := newToolHarness(t)
	for range 35 {
		createProjectThread(t, h)
	}
	started := h.req
	started.Operation = "started"
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, started); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash,wake_required)
 SELECT t.employee_id,$1,'turn_ended','thread:'||t.id::text||':turn:1',jsonb_build_object('thread_id',t.id::text,'version',1),$3,true
 FROM threads t WHERE t.project_id=$2 ORDER BY t.id DESC`, h.project.Agent.ID, h.project.ID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for batch := 0; batch < 2; batch++ {
		commands, err := h.repo.ClaimProjectRunCommands(h.ctx, protocol.BodyProjectRunWake)
		if err != nil || len(commands) != 1 {
			t.Fatal(commands, err)
		}
		c := commands[0].Command
		want := 32
		if batch == 1 {
			want = 3
		}
		if len(c.InputIDs) != want || len(c.ThreadUpdates) != want {
			t.Fatal(c)
		}
		for i, u := range c.ThreadUpdates {
			if seen[u.ThreadID] || (i > 0 && c.ThreadUpdates[i-1].ThreadID >= u.ThreadID) {
				t.Fatal("重复或排序错误", c)
			}
			seen[u.ThreadID] = true
			var version int64
			if err = h.pool.QueryRow(h.ctx, `SELECT version FROM threads WHERE id=$1`, u.ThreadID).Scan(&version); err != nil || u.Version != version || u.Version <= 1 {
				t.Fatal(u, version, err)
			}
		}
		receipt := h.req
		receipt.Operation = "wake_received"
		receipt.Payload, _ = json.Marshal(map[string]any{"input_ids": c.InputIDs})
		if _, err = h.repo.ProjectRuntime(h.ctx, h.src, receipt); err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 35 {
		t.Fatal(len(seen))
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='turn_ended' AND delivered_seq IS NOT NULL`); n != 0 {
		t.Fatal("通知确认写入了交付记录", n)
	}
}

func TestProjectShellTurnEndedQueuesAtomicallyAndWakesThreadVersion(t *testing.T) {
	h, req, p := execWaitFixture(t, 600)
	startProjectShell(t, h, p.ThreadID)
	started := h.req
	started.Operation = "started"
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, started); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, `CREATE FUNCTION reject_thread_input() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_type='turn_ended' THEN RAISE EXCEPTION 'injected input failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_thread_input BEFORE INSERT ON project_agent_input_queue FOR EACH ROW EXECUTE FUNCTION reject_thread_input()`); err != nil {
		t.Fatal(err)
	}
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: p.ThreadID, EventID: mustUUID(t), WorkerSeq: 4, WorkerTurnSeq: 1, Kind: "turn.ended", Reason: "agent_exited", QueueEmpty: true}
	if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err == nil || ack.OK {
		t.Fatal("输入失败仍提交终态", ack, err)
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, p.ThreadID)
	if err != nil || view.CurrentTurn == nil || view.Status != "running" {
		t.Fatal(view, err)
	}
	if _, err = h.pool.Exec(h.ctx, `DROP TRIGGER reject_thread_input ON project_agent_input_queue; DROP FUNCTION reject_thread_input()`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err != nil || !ack.OK {
			t.Fatal(ack, err)
		}
	}
	projectReport(t, h, p.ThreadID, "thread.unknown", func(r *protocol.ThreadReport) { r.Reason = "worker exited" })
	commands, err := h.repo.ClaimProjectRunCommands(h.ctx, protocol.BodyProjectRunWake)
	if err != nil || len(commands) != 1 || len(commands[0].Command.ThreadUpdates) != 1 || commands[0].Command.ThreadUpdates[0].ThreadID != p.ThreadID {
		t.Fatal(commands, err)
	}
	view, err = h.repo.GetThread(h.ctx, h.owner, p.ThreadID)
	if err != nil || commands[0].Command.ThreadUpdates[0].Version != view.Version {
		t.Fatal("提示版本错误", err)
	}
	// 不依赖通知，持久状态仍能结束等待并确认输入。
	req.Operation = "wait_tool"
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	e := out.(projectagent.Event)
	raw, _ := toolText(t, e)
	if !strings.Contains(string(raw), "状态不确定") {
		t.Fatal(string(raw))
	}
	if n := countRows(t, h.ctx, h.pool, `SELECT count(*) FROM project_agent_input_queue WHERE source_type='turn_ended' AND delivered_seq IS NULL`); n != 0 {
		t.Fatal(n)
	}
}

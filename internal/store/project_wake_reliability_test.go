package store_test

import (
	"encoding/json"
	"strings"
	"testing"

	"baton/internal/projectagent"
	"baton/internal/protocol"
)

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

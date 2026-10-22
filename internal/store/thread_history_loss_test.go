package store_test

import (
	"encoding/json"
	"testing"

	"baton/internal/protocol"
)

func TestThreadHistoryLossEndsActiveProjectTurnOnce(t *testing.T) {
	for _, kind := range []string{"thread.stopped", "thread.unknown"} {
		t.Run(kind, func(t *testing.T) {
			h := newToolHarness(t)
			id := createProjectThread(t, h)
			startProjectShell(t, h, id)
			projectReport(t, h, id, "reply", func(r *protocol.ThreadReport) {
				r.WorkerTurnSeq, r.Content = 1, "saved reply"
			})
			before, err := h.repo.GetThread(h.ctx, h.owner, id)
			if err != nil {
				t.Fatal(err)
			}
			r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: mustUUID(t), WorkerSeq: before.LastWorkerSeq + 1, Kind: kind, Reason: "本地 Thread 历史不可恢复"}
			if _, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err == nil {
				t.Fatal("普通状态报告越过未结束的 Turn")
			}
			r.HistoryUnavailable = true
			for range 3 {
				ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r)
				if err != nil || !ack.OK {
					t.Fatal(ack, err)
				}
			}
			var active, ended, inputs, audits int
			if err := h.pool.QueryRow(h.ctx, `SELECT
				(SELECT count(*) FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL),
				(SELECT count(*) FROM thread_turns WHERE thread_id=$1 AND ended_at IS NOT NULL AND end_reason='agent_exited'),
				(SELECT count(*) FROM project_agent_input_queue WHERE payload->>'thread_id'=$1::text AND source_type='turn_ended' AND payload->>'reason'='agent_exited' AND wake_required),
				(SELECT count(*) FROM thread_events WHERE thread_id=$1 AND kind='turn.ended')`, id).Scan(&active, &ended, &inputs, &audits); err != nil || active != 0 || ended != 1 || inputs != 1 || audits != 1 {
				t.Fatalf("active=%d ended=%d inputs=%d audits=%d err=%v", active, ended, inputs, audits, err)
			}
			view, err := h.repo.GetThread(h.ctx, h.owner, id)
			if err != nil || "thread."+view.Status != kind || view.LastWorkerSeq != r.WorkerSeq {
				t.Fatal(view, err)
			}
			var ordered bool
			if err := h.pool.QueryRow(h.ctx, `SELECT
				(SELECT min(id) FROM project_agent_input_queue WHERE source_type='thread_reply' AND payload->>'thread_id'=$1) <
				(SELECT min(id) FROM project_agent_input_queue WHERE source_type='turn_ended' AND payload->>'thread_id'=$1)`, id).Scan(&ordered); err != nil || !ordered {
				t.Fatal("恢复通知早于已保存回复", err)
			}
			r.HistoryUnavailable = false
			if _, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err == nil {
				t.Fatal("相同事件身份接受不同的恢复标记")
			}
		})
	}
}

func TestThreadHistoryLossReportRollsBackTurnAndProjectInput(t *testing.T) {
	h := newToolHarness(t)
	id := createProjectThread(t, h)
	startProjectShell(t, h, id)
	before, err := h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	r := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: id, EventID: mustUUID(t), WorkerSeq: before.LastWorkerSeq + 1, Kind: "thread.unknown", HistoryUnavailable: true, Reason: "本地 Thread 历史持续无法读取"}
	if _, err := h.pool.Exec(h.ctx, `CREATE FUNCTION reject_history_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
		CREATE TRIGGER reject_history_report BEFORE INSERT ON thread_reports FOR EACH ROW EXECUTE FUNCTION reject_history_report()`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.repo.SaveThreadReport(h.ctx, h.src, r); err == nil {
		t.Fatal("忽略报告提交失败")
	}
	view, err := h.repo.GetThread(h.ctx, h.owner, id)
	if err != nil || view.Status != "running" || view.LastWorkerSeq != before.LastWorkerSeq {
		t.Fatal(view, err)
	}
	var active, inputs, audits int
	if err := h.pool.QueryRow(h.ctx, `SELECT
		(SELECT count(*) FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL),
		(SELECT count(*) FROM project_agent_input_queue WHERE payload->>'thread_id'=$1::text AND source_type='turn_ended'),
		(SELECT count(*) FROM thread_events WHERE thread_id=$1 AND kind='turn.ended')`, id).Scan(&active, &inputs, &audits); err != nil || active != 1 || inputs != 0 || audits != 0 {
		t.Fatal(active, inputs, audits, err)
	}
	if _, err := h.pool.Exec(h.ctx, `DROP TRIGGER reject_history_report ON thread_reports`); err != nil {
		t.Fatal(err)
	}
	ack, err := h.repo.SaveThreadReport(h.ctx, h.src, r)
	if err != nil || !ack.OK {
		t.Fatal(ack, err)
	}
}

func TestShellThreadHistoryLossRetainsSavedOutputWithoutExitCode(t *testing.T) {
	for _, output := range []string{"", "saved partial output"} {
		t.Run(output, func(t *testing.T) {
			h, _, pending := execWaitFixture(t, 600)
			id := pending.ThreadID
			startProjectShell(t, h, id)
			if output != "" {
				projectReport(t, h, id, "reply", func(r *protocol.ThreadReport) {
					r.WorkerTurnSeq, r.Content = 1, output
				})
			}
			projectReport(t, h, id, "thread.unknown", func(r *protocol.ThreadReport) {
				r.HistoryUnavailable, r.Reason = true, "本地 Thread 历史不可恢复"
			})
			var raw []byte
			if err := h.pool.QueryRow(h.ctx, `SELECT payload FROM project_agent_input_queue WHERE source_key=$1`, "thread:"+id+":turn:1").Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var payload struct {
				Reason string         `json:"reason"`
				Result map[string]any `json:"command_result"`
			}
			if err := json.Unmarshal(raw, &payload); err != nil || payload.Reason != "agent_exited" || payload.Result["output"] != output {
				t.Fatal(string(raw), err)
			}
			if _, exists := payload.Result["exit_code"]; exists {
				t.Fatal("未知命令结果不应包含推测的退出码", string(raw))
			}
		})
	}
}

func TestThreadHistoryLossDoesNotNotifyProjectForEmployeeTurn(t *testing.T) {
	h := newThreadHarness(t)
	v := h.create("lost-history")
	h.opened(v)
	h.start(v, 2, 1, "lost-history:first")
	h.report(v.ID, 4, "thread.unknown", func(r *protocol.ThreadReport) {
		r.HistoryUnavailable, r.Reason = true, "本地 Thread 历史不可恢复"
	})
	if n := h.count(`SELECT count(*) FROM thread_turns WHERE thread_id=$1 AND ended_at IS NULL`, v.ID); n != 0 {
		t.Fatal("员工 Turn 未结束", n)
	}
	if n := h.count(`SELECT count(*) FROM project_agent_input_queue`); n != 0 {
		t.Fatal("员工 Turn 写入 Project 队列", n)
	}
	bad := protocol.ThreadReport{Type: protocol.BodyThreadReport, ThreadID: v.ID, EventID: mustUUID(t), WorkerSeq: 5, Kind: "turn.ended", WorkerTurnSeq: 1, Reason: "agent_exited", HistoryUnavailable: true}
	if _, err := h.repo.SaveThreadReport(h.ctx, h.src, bad); err == nil {
		t.Fatal("接受了其他报告类型上的恢复标记")
	}
}

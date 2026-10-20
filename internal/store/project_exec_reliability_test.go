package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
	"baton/internal/task"
	"github.com/jackc/pgx/v5"
)

type waitPending struct {
	Pending         bool   `json:"pending"`
	TaskID          string `json:"task_id"`
	TaskVersion     int64  `json:"task_version"`
	WaitRemainingMS int64  `json:"wait_remaining_ms"`
	WaitProtocol    int    `json:"wait_protocol"`
}

func execWaitFixture(t *testing.T, seconds int) (*toolHarness, protocol.ProjectRuntimeRequest, waitPending) {
	t.Helper()
	h := newToolHarness(t)
	enableExec(t, h)
	req := h.save(t, "nodes.exec", execArgs(h, seconds))
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil {
		t.Fatal(err)
	}
	return h, req, decodeWaitPending(t, out)
}

func decodeWaitPending(t *testing.T, out any) waitPending {
	t.Helper()
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var p waitPending
	if err = json.Unmarshal(raw, &p); err != nil || !p.Pending || p.TaskID == "" || p.TaskVersion < 1 || p.WaitRemainingMS < 0 || p.WaitProtocol != 1 {
		t.Fatalf("pending 协议无效: %s %v", raw, err)
	}
	return p
}

func TestProjectExecWaitPendingDoesNotAcquireRowLocks(t *testing.T) {
	h, req, first := execWaitFixture(t, 600)
	var deadline, lease time.Time
	if err := h.pool.QueryRow(h.ctx, `SELECT t.exec_wait_until,a.lease_until FROM tasks t JOIN project_agents a ON a.project_id=t.project_id WHERE t.id=$1`, first.TaskID).Scan(&deadline, &lease); err != nil {
		t.Fatal(err)
	}
	locked, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(h.ctx)
	for _, q := range []struct{ sql, id string }{
		{`SELECT id FROM project_agents WHERE id=$1 FOR UPDATE`, h.project.Agent.ID},
		{`SELECT id FROM conversations WHERE id=$1 FOR UPDATE`, h.project.Conversation.ID},
		{`SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, first.TaskID},
		{`SELECT id FROM nodes WHERE id=$1 FOR UPDATE`, h.src.NodeID},
		{`SELECT id FROM node_credentials WHERE id=$1 FOR UPDATE`, h.src.CredentialID},
		{`SELECT node_id FROM node_presence WHERE node_id=$1 FOR UPDATE`, h.src.NodeID},
	} {
		if _, err = locked.Exec(h.ctx, q.sql, q.id); err != nil {
			t.Fatal(err)
		}
	}
	req.Operation = "wait_tool"
	ctx, cancel := context.WithTimeout(h.ctx, 2*time.Second)
	defer cancel()
	out, err := h.repo.ProjectRuntime(ctx, h.src, req)
	if err != nil {
		t.Fatalf("pending 等待了显式行锁: %v", err)
	}
	p := decodeWaitPending(t, out)
	if p.TaskID != first.TaskID || p.TaskVersion != first.TaskVersion || p.WaitRemainingMS > first.WaitRemainingMS || p.WaitRemainingMS == 0 {
		t.Fatalf("pending 丢失绑定、版本或预算: %+v", p)
	}
	if err = locked.Rollback(h.ctx); err != nil {
		t.Fatal(err)
	}
	var afterDeadline, afterLease time.Time
	var seq int64
	if err = h.pool.QueryRow(h.ctx, `SELECT t.exec_wait_until,a.lease_until,c.next_seq FROM tasks t JOIN project_agents a ON a.project_id=t.project_id JOIN conversations c ON c.agent_id=a.id WHERE t.id=$1`, first.TaskID).Scan(&afterDeadline, &afterLease, &seq); err != nil {
		t.Fatal(err)
	}
	if !deadline.Equal(afterDeadline) || !lease.Equal(afterLease) || seq != req.LastSeq+1 {
		t.Fatal("pending 改变了等待期限、租约或序号")
	}
	if _, err = h.pool.Exec(h.ctx, `UPDATE tasks SET version=version+1,exec_wait_until=exec_wait_until-interval '1 minute' WHERE id=$1`, p.TaskID); err != nil {
		t.Fatal(err)
	}
	for _, op := range []string{"call_tool", "wait_tool", "call_tool", "wait_tool"} {
		req.Operation = op
		out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
		if err != nil {
			t.Fatal(err)
		}
		p = decodeWaitPending(t, out)
		if p.TaskID != first.TaskID || p.TaskVersion != first.TaskVersion+1 || p.WaitRemainingMS > first.WaitRemainingMS-60000 || p.WaitRemainingMS <= 0 {
			t.Fatalf("%s 重放没有返回原任务当前版本和预算: %+v", op, p)
		}
	}
	if err = h.pool.QueryRow(h.ctx, `SELECT exec_wait_until FROM tasks WHERE id=$1`, p.TaskID).Scan(&afterDeadline); err != nil || !afterDeadline.Equal(deadline.Add(-time.Minute)) {
		t.Fatal("重复请求延长了等待期限", err)
	}
}

func TestProjectExecWaitValidatesSourceBeforePendingAndReplay(t *testing.T) {
	cases := []struct {
		name   string
		change func(*toolHarness, *protocol.Source, *protocol.ProjectRuntimeRequest) error
	}{
		{"connection", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			s.ConnID = mustUUID(t)
			return nil
		}},
		{"employee", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			s.EmployeeID = mustUUID(t)
			return nil
		}},
		{"node", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			s.NodeID = mustUUID(t)
			return nil
		}},
		{"credential", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			s.CredentialID = mustUUID(t)
			return nil
		}},
		{"epoch", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			r.LeaseEpoch++
			return nil
		}},
		{"run", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			r.RunID = mustUUID(t)
			return nil
		}},
		{"expired_lease", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, h.project.Agent.ID)
			return err
		}},
		{"expired_credential", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE node_credentials SET created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, s.CredentialID)
			return err
		}},
		{"revoked_credential", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=$1`, s.CredentialID)
			return err
		}},
		{"revoked_node", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE nodes SET revoked_at=clock_timestamp() WHERE id=$1`, s.NodeID)
			return err
		}},
		{"offline", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE node_presence SET online=false WHERE node_id=$1`, s.NodeID)
			return err
		}},
		{"unsynced", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE node_presence SET synced=false WHERE node_id=$1`, s.NodeID)
			return err
		}},
		{"paused_project", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE projects SET status='paused' WHERE id=$1`, h.project.ID)
			return err
		}},
		{"finished_run", func(h *toolHarness, s *protocol.Source, r *protocol.ProjectRuntimeRequest) error {
			_, err := h.pool.Exec(h.ctx, `UPDATE agent_runs SET state='finished' WHERE id=$1`, r.RunID)
			return err
		}},
	}
	for _, replay := range []bool{false, true} {
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%s/replay=%t", tc.name, replay), func(t *testing.T) {
				h, req, _ := execWaitFixture(t, 600)
				req.Operation = "wait_tool"
				if replay {
					req.Payload = json.RawMessage(`{"finish_wait":true}`)
					out, err := h.repo.ProjectRuntime(h.ctx, h.src, req)
					if err != nil {
						t.Fatal(err)
					}
					first := out.(projectagent.Event)
					// 重放先于 last_seq、payload 与原任务的检查。
					req.LastSeq = -1
					req.Payload = json.RawMessage(`{"bad":true}`)
					out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
					if err != nil || out.(projectagent.Event).Seq != first.Seq {
						t.Fatal("原结果未按既有规则重放", err)
					}
				}
				src := h.src
				if err := tc.change(h, &src, &req); err != nil {
					t.Fatal(err)
				}
				if _, err := h.repo.ProjectRuntime(h.ctx, src, req); !errors.Is(err, projectagent.ErrLeaseLost) {
					t.Fatalf("失效来源仍获得结果: %v", err)
				}
			})
		}
	}
}

func TestProjectExecWaitValidatesConversationAndTaskBinding(t *testing.T) {
	for _, change := range []string{"last_seq", "tool_call", "task_project", "task_origin", "assistant", "intervening_input"} {
		t.Run(change, func(t *testing.T) {
			h, req, p := execWaitFixture(t, 600)
			req.Operation = "wait_tool"
			var err error
			switch change {
			case "last_seq":
				req.LastSeq--
			case "tool_call":
				req.ToolCallID = "another-call"
			case "task_project":
				other, e := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "其他项目"})
				if e != nil {
					t.Fatal(e)
				}
				_, err = h.pool.Exec(h.ctx, `UPDATE tasks SET project_id=$2 WHERE id=$1`, p.TaskID, other.ID)
			case "task_origin":
				_, err = h.pool.Exec(h.ctx, `UPDATE tasks SET origin_tool_call_id='another-call' WHERE id=$1`, p.TaskID)
			case "assistant":
				h.save(t, "nodes.exec", execArgs(h, 600))
				req.LastSeq = h.seq
			case "intervening_input":
				acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "interrupt", "新输入")
				claim := h.req
				claim.Operation, claim.LastSeq = "claim_inputs", req.LastSeq
				out, e := h.repo.ProjectRuntime(h.ctx, h.src, claim)
				if e != nil {
					t.Fatal(e)
				}
				req.LastSeq = out.(projectagent.Claim).Event.Seq
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, finish := range []bool{false, true} {
				req.Payload, _ = json.Marshal(map[string]bool{"finish_wait": finish})
				if _, err = h.repo.ProjectRuntime(h.ctx, h.src, req); !errors.Is(err, projectagent.ErrInvalid) && !errors.Is(err, projectagent.ErrConflict) {
					t.Fatalf("错误绑定仍可等待: finish=%t err=%v", finish, err)
				}
			}
		})
	}
}

func waitProjectQueryBlocked(t *testing.T, h *toolHarness, locked pgx.Tx, pattern string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := h.pool.QueryRow(h.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $2 AND $1=ANY(pg_blocking_pids(pid)))`, locked.Conn().PgConn().PID(), pattern).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("请求未进入预期写事务锁等待")
}

func TestProjectExecWaitRevalidatesAfterSnapshot(t *testing.T) {
	for _, change := range []string{"credential", "epoch", "project"} {
		t.Run(change, func(t *testing.T) {
			h, req, _ := execWaitFixture(t, 600)
			req.Operation, req.Payload = "wait_tool", json.RawMessage(`{"finish_wait":true}`)
			locked, err := h.pool.Begin(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locked.Rollback(h.ctx)
			if _, err = locked.Exec(h.ctx, `SELECT id FROM project_agents WHERE id=$1 FOR UPDATE`, h.project.Agent.ID); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := h.repo.ProjectRuntime(ctx, h.src, req); result <- err }()
			waitProjectQueryBlocked(t, h, locked, "%FOR NO KEY UPDATE OF a%")
			switch change {
			case "credential":
				_, err = locked.Exec(h.ctx, `UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=$1`, h.src.CredentialID)
			case "epoch":
				_, err = locked.Exec(h.ctx, `UPDATE project_agents SET lease_epoch=lease_epoch+1 WHERE id=$1`, h.project.Agent.ID)
			case "project":
				_, err = locked.Exec(h.ctx, `UPDATE projects SET status='paused' WHERE id=$1`, h.project.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = locked.Commit(h.ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-result; !errors.Is(err, projectagent.ErrLeaseLost) {
				t.Fatalf("最终事务未重新验证: %v", err)
			}
			var n int
			if err = h.pool.QueryRow(h.ctx, `SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result'`, h.project.Conversation.ID).Scan(&n); err != nil || n != 0 {
				t.Fatal("旧运行写入了结果", n, err)
			}
		})
	}
}

func TestProjectExecWaitCompletionAfterReadWinsOverExpiredWait(t *testing.T) {
	h, req, p := execWaitFixture(t, 0)
	locked, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(h.ctx)
	if _, err = locked.Exec(h.ctx, `UPDATE tasks SET status='completed',version=version+1,summary='完成' WHERE id=$1`, p.TaskID); err != nil {
		t.Fatal(err)
	}
	in := store.ProjectTaskResultInput{TaskID: p.TaskID, Version: p.TaskVersion + 1, Status: task.StatusCompleted, Text: "完成"}
	if err = store.EnqueueProjectTaskResult(h.ctx, locked, h.owner, h.project.Agent.ID, in); err != nil {
		t.Fatal(err)
	}
	req.Operation = "wait_tool"
	ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	type response struct {
		data any
		err  error
	}
	result := make(chan response, 1)
	go func() { out, err := h.repo.ProjectRuntime(ctx, h.src, req); result <- response{out, err} }()
	waitProjectQueryBlocked(t, h, locked, "%origin_tool_call_id=$4%FOR UPDATE%")
	if err = locked.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	r := <-result
	if r.err != nil {
		t.Fatal(r.err)
	}
	e := r.data.(projectagent.Event)
	raw, _ := toolText(t, e)
	var output struct {
		Status  string `json:"status"`
		Version int64  `json:"version"`
	}
	if err = json.Unmarshal(raw, &output); err != nil || output.Status != task.StatusCompleted || output.Version != in.Version {
		t.Fatal("提交使用了锁之前的过期等待快照", string(raw), err)
	}
	var delivered *int64
	if err = h.pool.QueryRow(h.ctx, `SELECT delivered_seq FROM project_agent_input_queue WHERE agent_id=$1 AND source_key=$2`, h.project.Agent.ID, fmt.Sprintf("task:%s:result:%d", p.TaskID, in.Version)).Scan(&delivered); err != nil || delivered == nil || *delivered != e.Seq {
		t.Fatal("同步结果没有事务确认输入", err)
	}
	claim := h.req
	claim.Operation, claim.LastSeq = "claim_inputs", e.Seq
	out, err := h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || out.(projectagent.Claim).Event != nil {
		t.Fatal("同步结果重复作为输入领取", err)
	}
	// 后续版本仍须投递，旧工具结果继续重放。
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	in.Version++
	if _, err = tx.Exec(h.ctx, `UPDATE tasks SET version=$2 WHERE id=$1`, p.TaskID, in.Version); err != nil {
		t.Fatal(err)
	}
	if err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, in); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
	if err != nil || out.(projectagent.Event).Seq != e.Seq {
		t.Fatal("后续版本改变了原工具结果", err)
	}
	out, err = h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || out.(projectagent.Claim).InputCount != 1 {
		t.Fatal("后续版本被同步确认吞掉", err)
	}
}

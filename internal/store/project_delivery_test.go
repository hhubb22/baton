package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"baton/internal/migrate"
	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

func deliveryHarness(t *testing.T) *toolHarness {
	t.Helper()
	h := newToolHarness(t)
	r := h.req
	r.Operation = "started"
	data, err := h.repo.ProjectRuntime(h.ctx, h.src, r)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(data)
	var capability struct {
		LeaseSeconds    int `json:"lease_seconds"`
		ControlReceipts int `json:"control_receipts"`
	}
	if err = json.Unmarshal(raw, &capability); err != nil || capability.LeaseSeconds != 60 || capability.ControlReceipts != 1 {
		t.Fatal("缺少控制回执能力", string(raw), err)
	}
	return h
}

func claimDelivery(t *testing.T, h *toolHarness, kind string) []projectagent.RunCommand {
	t.Helper()
	commands, err := h.repo.ClaimProjectRunCommands(h.ctx, kind)
	if err != nil {
		t.Fatal(err)
	}
	return commands
}

func wakeReceipt(req protocol.ProjectRuntimeRequest, ids []int64) protocol.ProjectRuntimeRequest {
	req.Operation = "wake_received"
	req.Payload, _ = json.Marshal(map[string]any{"input_ids": ids})
	return req
}

func insertDeliveryRun(t *testing.T, h *toolHarness, src protocol.Source, state string) (projectagent.Project, string) {
	t.Helper()
	p, err := h.repo.CreateProject(h.ctx, h.owner, projectagent.CreateInput{Title: "投递", Provider: "openai-codex", Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	id := mustUUID(t)
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	if _, err = tx.Exec(h.ctx, `INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason,stop_requested_at)
 VALUES($1,$2,$3,$4,1,$5,'openai-codex','test','test',CASE WHEN $5='finished' THEN clock_timestamp() END)`, id, h.owner, p.Agent.ID, src.NodeID, state); err != nil {
		t.Fatal(err)
	}
	if state != "finished" {
		if _, err = tx.Exec(h.ctx, `UPDATE project_agents SET lease_run_id=$2,lease_epoch=1,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1`, p.Agent.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	if state == "running" {
		acceptProjectInput(t, h.ctx, h.repo, h.owner, p.ID, "wake", "消息")
	}
	return p, id
}

func TestProjectDeliveryOldStopsDoNotStarveStartWakeOrOtherNodes(t *testing.T) {
	h := deliveryHarness(t)
	other := projectRunNode(t, h.ctx, h.pool, h.repo, h.owner, "另一个节点", true)
	_, otherStop := insertDeliveryRun(t, h, other, "finished")
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason,started_at,ended_at,stop_requested_at,command_next_at)
 SELECT gen_random_uuid(),$1,$2,$3,100+g,'lost','openai-codex','test','old',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'
 FROM generate_series(1,1000) g`, h.owner, h.project.Agent.ID, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	_, start := insertDeliveryRun(t, h, h.src, "starting")
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "wake", "唤醒")
	commands, err := h.repo.ProjectRunCommands(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	found := map[string]bool{}
	for _, c := range commands {
		counts[c.Command.Type]++
		found[c.Command.RunID] = true
	}
	if counts[protocol.BodyProjectRunStart] != 1 || counts[protocol.BodyProjectRunWake] != 1 || counts[protocol.BodyProjectRunStop] != 3 || !found[otherStop] || !found[start] {
		t.Fatalf("旧停止记录挤占其他节点或命令: counts=%v found=%v", counts, found)
	}
	for _, c := range commands {
		if c.Command.Type != protocol.BodyProjectRunStop {
			continue
		}
		req := protocol.ProjectRuntimeRequest{Operation: "stopped", RunID: c.Command.RunID, LeaseEpoch: c.Command.LeaseEpoch}
		src := h.src
		if c.NodeID == other.NodeID {
			src = other
		}
		if _, err = h.repo.ProjectRuntime(h.ctx, src, req); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = h.pool.Exec(h.ctx, "UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	h.repo = store.New(h.pool)
	for _, c := range claimDelivery(t, h, protocol.BodyProjectRunStop) {
		if found[c.Command.RunID] {
			t.Fatal("已确认停止记录被重新领取", c.Command.RunID)
		}
	}
}

func TestProjectDeliveryBudgetsRotateBeyond32ForEveryKind(t *testing.T) {
	h := deliveryHarness(t)
	nodes := []protocol.Source{h.src}
	for i := 1; i < 17; i++ {
		nodes = append(nodes, projectRunNode(t, h.ctx, h.pool, h.repo, h.owner, fmt.Sprintf("节点%d", i), true))
	}
	for _, src := range nodes {
		for range 2 {
			insertDeliveryRun(t, h, src, "starting")
			insertDeliveryRun(t, h, src, "finished")
			insertDeliveryRun(t, h, src, "running")
		}
	}
	// 填满每个 wake 的 32 条输入，覆盖一次领取持久化 1024 行的批次。
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash,wake_required)
 SELECT a.employee_id,a.id,'user_message','batch:'||g,'{"content":"message"}'::jsonb,decode(repeat('00',32),'hex'),true
 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id CROSS JOIN generate_series(1,31) g
 WHERE r.state='running' AND a.id<>$1`, h.project.Agent.ID); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{protocol.BodyProjectRunStart, protocol.BodyProjectRunStop, protocol.BodyProjectRunWake} {
		seen := map[string]bool{}
		for pass, want := range []int{32, 2, 0} {
			counts := map[string]int{}
			ctx, cancel := context.WithTimeout(h.ctx, time.Second)
			commands, err := h.repo.ClaimProjectRunCommands(ctx, kind)
			cancel()
			if err != nil {
				t.Fatal("满批次没有在后台数据库期限内完成", kind, err)
			}
			if len(commands) != want {
				t.Fatalf("%s pass=%d got=%d want=%d", kind, pass, len(commands), want)
			}
			for _, c := range commands {
				counts[c.NodeID]++
				if kind == protocol.BodyProjectRunWake && len(c.Command.InputIDs) != 32 {
					t.Fatal("wake 批次未填满", len(c.Command.InputIDs))
				}
				if counts[c.NodeID] > 2 || seen[c.Command.RunID] {
					t.Fatal("节点超额或退避期间重复领取", kind, c)
				}
				seen[c.Command.RunID] = true
			}
		}
	}
}

func TestProjectDeliveryLockedCandidatesDoNotHideLaterNodes(t *testing.T) {
	h := deliveryHarness(t)
	nodes := []protocol.Source{h.src}
	for i := 1; i < 17; i++ {
		nodes = append(nodes, projectRunNode(t, h.ctx, h.pool, h.repo, h.owner, fmt.Sprintf("锁竞争节点%d", i), true))
	}
	for _, src := range nodes {
		for range 2 {
			insertDeliveryRun(t, h, src, "starting")
			insertDeliveryRun(t, h, src, "finished")
			insertDeliveryRun(t, h, src, "running")
		}
	}
	for _, tc := range []struct {
		kind, query string
	}{
		{protocol.BodyProjectRunStart, `SELECT r.id::text FROM agent_runs r WHERE r.state='starting' AND r.stop_requested_at IS NULL
 ORDER BY r.command_next_at,r.id LIMIT 32 FOR UPDATE OF r`},
		{protocol.BodyProjectRunStop, `SELECT r.id::text FROM agent_runs r WHERE r.stop_requested_at IS NOT NULL AND r.stop_acked_at IS NULL
 ORDER BY r.command_next_at,r.id LIMIT 32 FOR UPDATE OF r`},
		{protocol.BodyProjectRunWake, `SELECT r.id::text FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id
 CROSS JOIN LATERAL (SELECT q.wake_next_at,q.id FROM project_agent_input_queue q WHERE q.agent_id=a.id
 AND q.delivered_seq IS NULL AND q.wake_required ORDER BY q.wake_next_at,q.id LIMIT 1) q
 WHERE r.state='running' ORDER BY q.wake_next_at,q.id LIMIT 32 FOR NO KEY UPDATE OF a`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			locked, err := h.pool.Begin(h.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locked.Rollback(h.ctx)
			rows, err := locked.Query(h.ctx, tc.query)
			if err != nil {
				t.Fatal(err)
			}
			lockedRuns := map[string]bool{}
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					rows.Close()
					t.Fatal(err)
				}
				lockedRuns[id] = true
			}
			err = rows.Err()
			rows.Close()
			if err != nil || len(lockedRuns) != 32 {
				t.Fatal("未锁定前 32 个候选", len(lockedRuns), err)
			}
			ctx, cancel := context.WithTimeout(h.ctx, time.Second)
			commands, err := h.repo.ClaimProjectRunCommands(ctx, tc.kind)
			cancel()
			if err != nil || len(commands) != 2 {
				t.Fatalf("被锁候选挡住了后续节点: commands=%d err=%v", len(commands), err)
			}
			counts := map[string]int{}
			for _, c := range commands {
				counts[c.NodeID]++
				if lockedRuns[c.Command.RunID] || counts[c.NodeID] > 2 {
					t.Fatal("领取了被锁记录或超出节点额度", c)
				}
			}
			if err = locked.Rollback(h.ctx); err != nil {
				t.Fatal(err)
			}
			if remaining := claimDelivery(t, h, tc.kind); len(remaining) != 32 {
				t.Fatal("解锁后未能领取剩余记录", len(remaining))
			}
		})
	}
}

func TestProjectDeliveryRetrySchedulePersistsBeforeSend(t *testing.T) {
	h := deliveryHarness(t)
	_, id := insertDeliveryRun(t, h, h.src, "starting")
	for attempt := 1; attempt <= 8; attempt++ {
		if _, err := h.pool.Exec(h.ctx, "UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second' WHERE id=$1", id); err != nil {
			t.Fatal(err)
		}
		var before, after, next time.Time
		if err := h.pool.QueryRow(h.ctx, "SELECT clock_timestamp()").Scan(&before); err != nil {
			t.Fatal(err)
		}
		commands := claimDelivery(t, h, protocol.BodyProjectRunStart)
		if len(commands) != 1 || commands[0].Command.RunID != id {
			t.Fatal("没有领取启动", commands)
		}
		var stored int
		if err := h.pool.QueryRow(h.ctx, "SELECT command_attempts,command_next_at,clock_timestamp() FROM agent_runs WHERE id=$1", id).Scan(&stored, &next, &after); err != nil {
			t.Fatal(err)
		}
		upper := min(time.Second<<uint(attempt-1), 30*time.Second)
		lower := max(time.Second, upper-upper/5)
		if stored != attempt || next.Before(before.Add(lower)) || next.After(after.Add(upper)) {
			t.Fatalf("持久化退避错误 attempt=%d stored=%d delay=%s", attempt, stored, next.Sub(before))
		}
		h.repo = store.New(h.pool)
		if commands = claimDelivery(t, h, protocol.BodyProjectRunStart); len(commands) != 0 {
			t.Fatal("重建 Store 后提前重发", commands)
		}
	}
	req := protocol.ProjectRuntimeRequest{Operation: "started", RunID: id, LeaseEpoch: 1}
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, "UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	if commands := claimDelivery(t, h, protocol.BodyProjectRunStart); len(commands) != 0 {
		t.Fatal("started 后重发启动", commands)
	}
}

func TestProjectWakeReceiptIsIndependentOfClaimAndDeduplication(t *testing.T) {
	h := deliveryHarness(t)
	message, err := h.repo.AcceptProjectMessage(h.ctx, h.owner, h.project.ID, projectagent.MessageInput{ClientMessageID: "receipt", Content: "保留待认领"})
	if err != nil {
		t.Fatal(err)
	}
	commands := claimDelivery(t, h, protocol.BodyProjectRunWake)
	if len(commands) != 1 || len(commands[0].Command.InputIDs) != 1 || commands[0].Command.InputIDs[0] != message.ID {
		t.Fatal("wake 缺少精确输入 ID", commands)
	}
	var next time.Time
	var attempts int
	if err = h.pool.QueryRow(h.ctx, `SELECT wake_next_at,wake_attempts FROM project_agent_input_queue WHERE id=$1`, message.ID).Scan(&next, &attempts); err != nil || attempts != 1 {
		t.Fatal("发送前没有保存重试进度", attempts, err)
	}
	if c := claimDelivery(t, h, protocol.BodyProjectRunWake); len(c) != 0 {
		t.Fatal("wake 未退避", c)
	}
	receipt := wakeReceipt(h.req, []int64{message.ID})
	for range 2 {
		if _, err = h.repo.ProjectRuntime(h.ctx, h.src, receipt); err != nil {
			t.Fatal("确认不幂等", err)
		}
	}
	if _, err = h.repo.AcceptProjectMessage(h.ctx, h.owner, h.project.ID, projectagent.MessageInput{ClientMessageID: "receipt", Content: "保留待认领"}); err != nil {
		t.Fatal(err)
	}
	var required bool
	var delivered *int64
	var after time.Time
	var afterAttempts int
	if err = h.pool.QueryRow(h.ctx, `SELECT wake_required,delivered_seq,wake_next_at,wake_attempts FROM project_agent_input_queue WHERE id=$1`, message.ID).Scan(&required, &delivered, &after, &afterAttempts); err != nil || required || delivered != nil || !after.Equal(next) || afterAttempts != attempts {
		t.Fatal("确认修改交付或重复输入重新打开通知", required, delivered, err)
	}
	h.repo = store.New(h.pool)
	if c := claimDelivery(t, h, protocol.BodyProjectRunWake); len(c) != 0 {
		t.Fatal("已接收的输入被重发", c)
	}
	claim := h.req
	claim.Operation, claim.LastSeq = "claim_inputs", h.seq
	data, err := h.repo.ProjectRuntime(h.ctx, h.src, claim)
	if err != nil || data.(projectagent.Claim).InputCount != 1 {
		t.Fatal("接收回执影响了业务认领", data, err)
	}
}

func TestProjectWakeReceiptDoesNotCoverLowerIDCommittedLater(t *testing.T) {
	h := deliveryHarness(t)
	late, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer late.Rollback(h.ctx)
	if err = store.EnqueueProjectTaskResult(h.ctx, late, h.owner, h.project.Agent.ID, store.ProjectTaskResultInput{TaskID: mustUUID(t), Version: 1, Status: "completed"}); err != nil {
		t.Fatal(err)
	}
	var lower int64
	if err = late.QueryRow(h.ctx, "SELECT id FROM project_agent_input_queue WHERE agent_id=$1 AND delivered_seq IS NULL", h.project.Agent.ID).Scan(&lower); err != nil {
		t.Fatal(err)
	}
	message, err := h.repo.AcceptProjectMessage(h.ctx, h.owner, h.project.ID, projectagent.MessageInput{ClientMessageID: "higher", Content: "先提交"})
	if err != nil || message.ID <= lower {
		t.Fatal("ID 顺序错误", err)
	}
	commands := claimDelivery(t, h, protocol.BodyProjectRunWake)
	if len(commands) != 1 || len(commands[0].Command.InputIDs) != 1 || commands[0].Command.InputIDs[0] != message.ID {
		t.Fatal("读取到未提交输入", commands)
	}
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, wakeReceipt(h.req, commands[0].Command.InputIDs)); err != nil {
		t.Fatal(err)
	}
	if err = late.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	commands = claimDelivery(t, h, protocol.BodyProjectRunWake)
	if len(commands) != 1 || len(commands[0].Command.InputIDs) != 1 || commands[0].Command.InputIDs[0] != lower {
		t.Fatal("较小 ID 晚提交后遗漏通知", commands)
	}
}

func TestProjectWakeReceiptValidatesIDsAndCurrentIdentity(t *testing.T) {
	h := deliveryHarness(t)
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "identity", "保留")
	command := claimDelivery(t, h, protocol.BodyProjectRunWake)[0]
	id := command.Command.InputIDs[0]
	for _, ids := range [][]int64{nil, {}, {0}, {-1}, {id, id}, make([]int64, 33)} {
		if _, err := h.repo.ProjectRuntime(h.ctx, h.src, wakeReceipt(h.req, ids)); !errors.Is(err, projectagent.ErrInvalid) {
			t.Fatalf("接受非法 ID %v: %v", ids, err)
		}
	}
	for _, field := range []string{"node", "employee", "credential", "connection", "epoch"} {
		src, req := h.src, wakeReceipt(h.req, []int64{id})
		switch field {
		case "node":
			src.NodeID = mustUUID(t)
		case "employee":
			src.EmployeeID = mustUUID(t)
		case "credential":
			src.CredentialID = mustUUID(t)
		case "connection":
			src.ConnID = mustUUID(t)
		case "epoch":
			req.LeaseEpoch++
		}
		if _, err := h.repo.ProjectRuntime(h.ctx, src, req); !errors.Is(err, projectagent.ErrLeaseLost) {
			t.Fatal("错误身份接受确认", field, err)
		}
	}
	var required bool
	if err := h.pool.QueryRow(h.ctx, "SELECT wake_required FROM project_agent_input_queue WHERE id=$1", id).Scan(&required); err != nil || !required {
		t.Fatal("非法确认清除了通知", err)
	}
	foreign, _ := insertDeliveryRun(t, h, h.src, "running")
	var foreignID int64
	if err := h.pool.QueryRow(h.ctx, "SELECT id FROM project_agent_input_queue WHERE agent_id=$1", foreign.Agent.ID).Scan(&foreignID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, wakeReceipt(h.req, []int64{id, foreignID})); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(h.ctx, "SELECT wake_required FROM project_agent_input_queue WHERE id=$1", foreignID).Scan(&required); err != nil || !required {
		t.Fatal("跨 Agent 确认清除了通知", err)
	}
}

func waitProjectLock(t *testing.T, h *toolHarness, ctx context.Context, blocker uint32, query string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		if err := h.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
 AND wait_event_type='Lock' AND query LIKE $2 AND $1=ANY(pg_blocking_pids(pid)))`, blocker, query).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("没有观察到数据库锁等待", query)
}

func TestProjectWakeReceiptRacingHandoverCannotClearNewRun(t *testing.T) {
	h := deliveryHarness(t)
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "handover", "尚未认领")
	command := claimDelivery(t, h, protocol.BodyProjectRunWake)[0]
	receipt := wakeReceipt(h.req, command.Command.InputIDs)
	if _, err := h.repo.ProjectRuntime(h.ctx, h.src, receipt); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, "UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", h.project.Agent.ID); err != nil {
		t.Fatal(err)
	}
	locked, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(h.ctx)
	if _, err = locked.Exec(h.ctx, "SELECT id FROM nodes WHERE id=$1 FOR UPDATE", h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
	defer cancel()
	scheduled := make(chan error, 1)
	go func() { scheduled <- h.repo.ScheduleProjectRun(ctx, h.project.Agent.ID) }()
	waitProjectLock(t, h, ctx, locked.Conn().PgConn().PID(), "%FOR UPDATE OF n%")
	acked := make(chan error, 1)
	go func() { _, err := h.repo.ProjectRuntime(ctx, h.src, receipt); acked <- err }()
	// 旧确认在 Agent 锁后排队，放置事务提交后必须重新验证代次。
	var schedulerPID uint32
	if err = h.pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF n%' AND $1=ANY(pg_blocking_pids(pid))`, locked.Conn().PgConn().PID()).Scan(&schedulerPID); err != nil {
		t.Fatal(err)
	}
	waitProjectLock(t, h, ctx, schedulerPID, "%FOR NO KEY UPDATE OF a%")
	if err = locked.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-scheduled; err != nil {
		t.Fatal(err)
	}
	if err = <-acked; !errors.Is(err, projectagent.ErrLeaseLost) {
		t.Fatal("旧回执越过运行更换", err)
	}
	current := runtimeRequest(t, h.ctx, h.pool, h.project.Agent.ID, "started")
	if current.RunID == receipt.RunID || current.LeaseEpoch != receipt.LeaseEpoch+1 {
		t.Fatal("运行没有更换", current)
	}
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, current); err != nil {
		t.Fatal(err)
	}
	commands := claimDelivery(t, h, protocol.BodyProjectRunWake)
	if len(commands) != 1 || len(commands[0].Command.InputIDs) != 1 || commands[0].Command.InputIDs[0] != command.Command.InputIDs[0] {
		t.Fatal("新运行没有重新提示未认领输入", commands)
	}
	stopped := receipt
	stopped.Operation = "stopped"
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, stopped); err != nil {
		t.Fatal(err)
	}
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, current); err != nil {
		t.Fatal("历史停止确认破坏了新租约", err)
	}
	var state, reason string
	if err = h.pool.QueryRow(h.ctx, "SELECT state,end_reason FROM agent_runs WHERE id=$1", receipt.RunID).Scan(&state, &reason); err != nil || state != "lost" || reason != "lease_expired" {
		t.Fatal("历史停止确认更改了业务终态", state, reason, err)
	}
}

func TestProjectDeliveryReleaseUsesCallPathGraceAndStopAckPreservesOutcome(t *testing.T) {
	for _, operation := range []string{"finish", "report_failure", "start_failed", "exited", "user_stopped", "project_paused"} {
		t.Run(operation, func(t *testing.T) {
			h := deliveryHarness(t)
			req := h.req
			req.Operation, req.Reason = operation, "finish report_failure user_stopped"
			var err error
			switch operation {
			case "user_stopped":
				err = h.repo.StopProjectRun(h.ctx, h.owner, h.project.ID)
			case "project_paused":
				status := "paused"
				_, err = h.repo.PatchProject(h.ctx, h.owner, h.project.ID, projectagent.Patch{Status: &status})
			default:
				_, err = h.repo.ProjectRuntime(h.ctx, h.src, req)
			}
			if err != nil {
				t.Fatal(err)
			}
			var state, reason string
			var requested, next time.Time
			var current *string
			var attempts int
			if err = h.pool.QueryRow(h.ctx, `SELECT r.state,r.end_reason,r.stop_requested_at,r.command_next_at,r.command_attempts,a.lease_run_id::text
 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id WHERE r.id=$1`, req.RunID).Scan(&state, &reason, &requested, &next, &attempts, &current); err != nil || current != nil || attempts != 0 {
				t.Fatal("释放租约与停止意图不一致", current, attempts, err)
			}
			grace := operation == "finish" || operation == "report_failure"
			if grace && (next.Sub(requested) < 2*time.Second || next.Sub(requested) > 2100*time.Millisecond) {
				t.Fatal("缺少自然结束宽限", next.Sub(requested))
			}
			commands := claimDelivery(t, h, protocol.BodyProjectRunStop)
			if grace && len(commands) != 0 || !grace && len(commands) != 1 {
				t.Fatal("停止到期不符合调用路径", commands)
			}
			req.Operation = "stopped"
			for range 2 {
				if _, err = h.repo.ProjectRuntime(h.ctx, h.src, req); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = h.pool.Exec(h.ctx, "UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second' WHERE id=$1", req.RunID); err != nil {
				t.Fatal(err)
			}
			if commands = claimDelivery(t, h, protocol.BodyProjectRunStop); len(commands) != 0 {
				t.Fatal("已确认清理仍重发", commands)
			}
			var afterState, afterReason string
			if err = h.pool.QueryRow(h.ctx, "SELECT state,end_reason FROM agent_runs WHERE id=$1", req.RunID).Scan(&afterState, &afterReason); err != nil || state != afterState || reason != afterReason {
				t.Fatal("清理确认改变业务终态", afterState, afterReason, err)
			}
		})
	}
}

func TestProjectPlacementPageExcludesHealthyLeases(t *testing.T) {
	h := deliveryHarness(t)
	var first projectagent.Project
	for i := range 10 {
		src := projectRunNode(t, h.ctx, h.pool, h.repo, h.owner, fmt.Sprintf("健康节点%d", i), true)
		for j := range 4 {
			p, _ := insertDeliveryRun(t, h, src, "running")
			if i == 0 && j == 0 {
				first = p
			}
		}
		if i == 1 {
			// 断线但租约仍有效的运行也不参与回收。
			if _, err := h.pool.Exec(h.ctx, "UPDATE node_presence SET online=false WHERE node_id=$1", src.NodeID); err != nil {
				t.Fatal(err)
			}
		}
	}
	waiting := projectagent.Project{ID: mustUUID(t), Agent: projectagent.Agent{ID: "ffffffff-ffff-ffff-ffff-ffffffffffff"}}
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	if _, err = tx.Exec(h.ctx, "INSERT INTO projects(id,employee_id,title) VALUES($1,$2,'待放置')", waiting.ID, h.owner); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(h.ctx, "INSERT INTO project_agents(id,employee_id,project_id,provider,model) VALUES($1,$2,$3,'openai-codex','test')", waiting.Agent.ID, h.owner, waiting.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(h.ctx, "INSERT INTO conversations(id,employee_id,agent_id) VALUES($1,$2,$3)", mustUUID(t), h.owner, waiting.Agent.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	acceptProjectInput(t, h.ctx, h.repo, h.owner, waiting.ID, "waiting", "请开始")
	ids, err := h.repo.ListProjectRunCandidates(h.ctx, "", 32)
	if err != nil || len(ids) != 1 || ids[0] != waiting.Agent.ID {
		t.Fatal("健康租约占用了放置扫描的页额度", ids, err)
	}
	if _, err = h.pool.Exec(h.ctx, "UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", first.Agent.ID); err != nil {
		t.Fatal(err)
	}
	ids, err = h.repo.ListProjectRunCandidates(h.ctx, "", 32)
	if err != nil || len(ids) != 2 || ids[0] != first.Agent.ID || ids[1] != waiting.Agent.ID {
		t.Fatal("过期租约没有参与回收", ids, err)
	}
	page, err := h.repo.ListProjectRunCandidates(h.ctx, first.Agent.ID, 32)
	if err != nil || len(page) != 1 || page[0] != waiting.Agent.ID {
		t.Fatal("放置扫描没有按 Agent ID 继续分页", page, err)
	}
	if err = h.repo.ScheduleProjectRun(h.ctx, waiting.Agent.ID); err != nil {
		t.Fatal(err)
	}
	var run *string
	if err = h.pool.QueryRow(h.ctx, "SELECT lease_run_id::text FROM project_agents WHERE id=$1", waiting.Agent.ID).Scan(&run); err != nil || run == nil {
		t.Fatal("等待 Agent 未能在本轮放置", err)
	}
}

func TestProjectWakeInsertionDoesNotLockAgentAndDoesNotRearmDuplicates(t *testing.T) {
	h := deliveryHarness(t)
	locked, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Rollback(h.ctx)
	if _, err = locked.Exec(h.ctx, "SELECT id FROM project_agents WHERE id=$1 FOR NO KEY UPDATE", h.project.Agent.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(h.ctx, time.Second)
	defer cancel()
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	input := store.ProjectTaskResultInput{TaskID: mustUUID(t), Version: 3, Status: "completed"}
	if err = store.EnqueueProjectTaskResult(ctx, tx, h.owner, h.project.Agent.ID, input); err != nil {
		t.Fatal("任务通知插入等待了 Agent 锁", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = locked.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	command := claimDelivery(t, h, protocol.BodyProjectRunWake)[0]
	if _, err = h.repo.ProjectRuntime(h.ctx, h.src, wakeReceipt(h.req, command.Command.InputIDs)); err != nil {
		t.Fatal(err)
	}
	tx, err = h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	if err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, input); err != nil {
		t.Fatal(err)
	}
	input.NotificationOnly, input.TaskID = true, mustUUID(t)
	if err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, input); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	if commands := claimDelivery(t, h, protocol.BodyProjectRunWake); len(commands) != 0 {
		t.Fatal("重复或被动任务通知触发了 wake", commands)
	}
}

func TestProjectWakeEncodingLimitLeavesUnsentRowsImmediatelyDue(t *testing.T) {
	h := deliveryHarness(t)
	tx, err := h.pool.Begin(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(h.ctx)
	for i := range 8 {
		// 输入在既有 40KiB 限制内，合并成单条通知后会超过控制帧容量。
		input := store.ProjectTaskResultInput{TaskID: fmt.Sprint(i) + strings.Repeat("x", 32<<10), Version: 1, Status: "completed"}
		if err = store.EnqueueProjectTaskResult(h.ctx, tx, h.owner, h.project.Agent.ID, input); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(h.ctx); err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for range 2 {
		commands := claimDelivery(t, h, protocol.BodyProjectRunWake)
		if len(commands) != 1 || len(commands[0].Command.InputIDs) != 4 {
			t.Fatal("编码容量没有分批", commands)
		}
		c := commands[0].Command
		raw, err := protocol.MarshalJSON(c)
		if err != nil || len(raw) > protocol.MaxProjectRuntimeBytes-1024 {
			t.Fatal("wake 编码超限", len(raw), err)
		}
		for _, id := range c.InputIDs {
			if seen[id] {
				t.Fatal("未发送的后页输入没有优先于退避项", id)
			}
			seen[id] = true
		}
	}
	if len(seen) != 8 {
		t.Fatal("遗漏输入", len(seen))
	}
}

func TestProjectDeliveryMigrationInitializesOnlyUnconfirmedWork(t *testing.T) {
	h := deliveryHarness(t)
	_, pending := insertDeliveryRun(t, h, h.src, "finished")
	_, acked := insertDeliveryRun(t, h, h.src, "finished")
	_, starting := insertDeliveryRun(t, h, h.src, "starting")
	acceptProjectInput(t, h.ctx, h.repo, h.owner, h.project.ID, "migration", "未认领")
	if _, err := h.pool.Exec(h.ctx, "UPDATE agent_runs SET stop_acked_at=clock_timestamp() WHERE id=$1", acked); err != nil {
		t.Fatal(err)
	}
	// 回到新增投递列之前的 schema，再通过正式迁移入口应用。
	if _, err := h.pool.Exec(h.ctx, `ALTER TABLE agent_runs DROP COLUMN stop_requested_at,DROP COLUMN command_next_at,DROP COLUMN command_attempts;
 ALTER TABLE project_agent_input_queue DROP COLUMN wake_required,DROP COLUMN wake_next_at,DROP COLUMN wake_attempts;
 DELETE FROM schema_migrations WHERE version='0024_project_delivery.sql'`); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := h.pool.QueryRow(h.ctx, "SELECT clock_timestamp()").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate.Up(h.ctx, h.pool); err != nil {
		t.Fatal(err)
	}
	var requested *time.Time
	var next time.Time
	if err := h.pool.QueryRow(h.ctx, "SELECT stop_requested_at,command_next_at FROM agent_runs WHERE id=$1", pending).Scan(&requested, &next); err != nil || requested == nil || next.Before(before) || next.After(time.Now().Add(30*time.Second)) {
		t.Fatal("历史未确认清理没有建立错开的停止意图", requested, next, err)
	}
	if err := h.pool.QueryRow(h.ctx, "SELECT stop_requested_at FROM agent_runs WHERE id=$1", acked).Scan(&requested); err != nil || requested != nil {
		t.Fatal("已确认的历史运行被重新打开", requested, err)
	}
	if commands := claimDelivery(t, h, protocol.BodyProjectRunStart); len(commands) != 1 || commands[0].Command.RunID != starting {
		t.Fatal("迁移后既有启动丢失", commands)
	}
	if commands := claimDelivery(t, h, protocol.BodyProjectRunWake); len(commands) != 1 || len(commands[0].Command.InputIDs) != 1 {
		t.Fatal("迁移后未认领主动输入遗漏通知", commands)
	}
}

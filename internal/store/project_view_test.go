package store_test

import (
	"baton/internal/projectagent"
	"baton/internal/store"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestProjectViewWaitingRecoveryAndPreviewFence(t *testing.T) {
	ctx, pool, repo, owner, p, src := projectRunFixture(t)
	acceptProjectInput(t, ctx, repo, owner, p.ID, "original-message", "跨设备工作")
	if err := repo.MarkOffline(ctx, src.NodeID, src.ConnID, time.Now()); err != nil {
		t.Fatal(err)
	}
	view, err := repo.ProjectStatusView(ctx, owner, p.ID)
	if err != nil || view.State != "waiting" || view.WaitingReason != "all_devices_offline" || view.Run != nil {
		t.Fatalf("离线状态: %+v %v", view, err)
	}
	page, err := repo.ProjectMessages(ctx, owner, p.ID, "", 0, 1)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Content != "跨设备工作" {
		t.Fatalf("队列读取: %+v %v", page, err)
	}
	if _, err = repo.ProjectStatusView(ctx, mustID(t), p.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨员工状态: %v", err)
	}
	if _, err = repo.ProjectMessages(ctx, mustID(t), p.ID, "", 0, 1); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨员工消息: %v", err)
	}
	if err = repo.ConnectNode(ctx, src); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE node_presence SET synced=true WHERE node_id=$1`, src.NodeID); err != nil {
		t.Fatal(err)
	}
	if err = repo.ScheduleProjectRuns(ctx); err != nil {
		t.Fatal(err)
	}
	claim := runtimeRequest(t, ctx, pool, p.Agent.ID, "claim_inputs")
	value, err := repo.ProjectRuntime(ctx, src, claim)
	if err != nil {
		t.Fatal(err)
	}
	event := value.(projectagent.Claim).Event
	if event == nil {
		t.Fatal("没有领取")
	}
	preview := runtimeRequest(t, ctx, pool, p.Agent.ID, "preview")
	preview.LastSeq = event.Seq
	preview.Payload = json.RawMessage(`{"text":"临时回复"}`)
	if _, err = repo.ProjectRuntime(ctx, src, preview); err != nil {
		t.Fatal(err)
	}
	saved, err := repo.ProjectEvents(ctx, owner, p.ID, 0, 100)
	if err != nil || len(saved.Events) != 1 {
		t.Fatalf("预览进入历史: %+v %v", saved, err)
	}
	preview.LastSeq = 0
	if _, err = repo.ProjectRuntime(ctx, src, preview); !errors.Is(err, projectagent.ErrConflict) {
		t.Fatalf("过时预览: %v", err)
	}
	page, err = repo.ProjectMessages(ctx, owner, p.ID, "original-message", 0, 100)
	if err != nil || len(page.Messages) != 1 {
		t.Fatalf("领取后按标识恢复: %+v %v", page, err)
	}
	page, err = repo.ProjectMessages(ctx, owner, p.ID, "", 0, 100)
	if err != nil || len(page.Messages) != 0 {
		t.Fatalf("已领取仍排队: %+v %v", page, err)
	}
	if _, err = pool.Exec(ctx, `UPDATE conversations SET state='needs_attention',attention_reason='订阅错误',failure_count=3 WHERE id=$1`, p.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	view, err = repo.ProjectStatusView(ctx, owner, p.ID)
	if err != nil || view.State != "needs_attention" || view.LastError == nil || *view.LastError != "订阅错误" {
		t.Fatalf("错误状态: %+v %v", view, err)
	}
	if err = repo.RetryProject(ctx, owner, p.ID); err != nil {
		t.Fatal(err)
	}
	if err = repo.StopProjectRun(ctx, owner, p.ID); err != nil {
		t.Fatal(err)
	}
	preview.LastSeq = event.Seq
	if _, err = repo.ProjectRuntime(ctx, src, preview); !errors.Is(err, projectagent.ErrLeaseLost) {
		t.Fatalf("旧运行预览: %v", err)
	}
}

func TestProjectWaitingReasonsAndMessagePagination(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	check := func(state, reason string) {
		t.Helper()
		v, e := repo.ProjectStatusView(ctx, owner, p.ID)
		if e != nil || v.State != state || v.WaitingReason != reason {
			t.Fatalf("状态: %+v %v，期望 %s %s", v, e, state, reason)
		}
	}
	check("idle", "")
	for _, id := range []string{"one", "two", "three"} {
		acceptProjectInput(t, ctx, repo, owner, p.ID, id, id)
	}
	check("waiting", "model_not_configured")
	first, err := repo.ProjectMessages(ctx, owner, p.ID, "", 0, 2)
	if err != nil || len(first.Messages) != 2 || first.NextAfterID == 0 {
		t.Fatalf("首批消息: %+v %v", first, err)
	}
	second, err := repo.ProjectMessages(ctx, owner, p.ID, "", first.NextAfterID, 2)
	if err != nil || len(second.Messages) != 1 || second.Messages[0].ClientMessageID != "three" || second.NextAfterID != 0 {
		t.Fatalf("第二批消息: %+v %v", second, err)
	}
	provider, model := "openai-codex", "test"
	if _, err = repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Provider: &provider, Model: &model}); err != nil {
		t.Fatal(err)
	}
	check("waiting", "all_devices_offline")
	src := projectRunNode(t, ctx, pool, repo, owner, "需登录设备", false)
	check("waiting", "login_required")
	if _, err = pool.Exec(ctx, `UPDATE node_presence SET synced=false WHERE node_id=$1`, src.NodeID); err != nil {
		t.Fatal(err)
	}
	check("waiting", "waiting_sync")
	if _, err = pool.Exec(ctx, `UPDATE node_presence SET synced=true WHERE node_id=$1`, src.NodeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM node_runtime_reports WHERE node_id=$1`, src.NodeID); err != nil {
		t.Fatal(err)
	}
	check("waiting", "runtime_missing")
	paused := "paused"
	if _, err = repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Status: &paused}); err != nil {
		t.Fatal(err)
	}
	check("paused", "")
}

package store_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/store"
)

func TestProjectAgentLeaseOptions(t *testing.T) {
	for _, tc := range []struct {
		name     string
		legacy   bool
		duration time.Duration
		seconds  int
	}{
		{name: "New_default", legacy: true, seconds: 60},
		{name: "zero_default", seconds: 60},
		{name: "negative_default", duration: -time.Second, seconds: 60},
		{name: "short", duration: 3 * time.Second, seconds: 3},
		{name: "fractional_rounds_up", duration: 2500 * time.Millisecond, seconds: 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, pool, repo, owner, p, src := projectRunFixture(t)
			if tc.legacy {
				repo = store.New(pool)
			} else {
				repo = store.NewWithOptions(pool, store.Options{ProjectAgentLeaseDuration: tc.duration})
			}
			acceptProjectInput(t, ctx, repo, owner, p.ID, "lease-options", "执行任务")

			// 使用数据库时钟包住操作，精确核对 SQL 和响应的租期，不等待真实到期。
			databaseNow := func() time.Time {
				t.Helper()
				var now time.Time
				if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
					t.Fatal(err)
				}
				return now
			}
			leaseUntil := func() time.Time {
				t.Helper()
				var until time.Time
				if err := pool.QueryRow(ctx, `SELECT lease_until FROM project_agents WHERE id=$1`, p.Agent.ID).Scan(&until); err != nil {
					t.Fatal(err)
				}
				return until
			}
			checkDuration := func(before time.Time) {
				t.Helper()
				after := databaseNow()
				until := leaseUntil()
				ttl := time.Duration(tc.seconds) * time.Second
				if until.Before(before.Add(ttl)) || until.After(after.Add(ttl)) {
					t.Fatalf("SQL 租期应为 %s: 操作区间 [%s, %s], lease_until=%s", ttl, before, after, until)
				}
			}
			before := databaseNow()
			if err := repo.ScheduleProjectRuns(ctx); err != nil {
				t.Fatal(err)
			}
			checkDuration(before)
			request := runtimeRequest(t, ctx, pool, p.Agent.ID, "started")
			allocated := leaseUntil()
			if err := repo.ScheduleProjectRuns(ctx); err != nil {
				t.Fatal(err)
			}
			current := runtimeRequest(t, ctx, pool, p.Agent.ID, "started")
			if current.RunID != request.RunID || current.LeaseEpoch != request.LeaseEpoch || !leaseUntil().Equal(allocated) {
				t.Fatal("有效租约被重新分配或延长")
			}

			for _, operation := range []string{"started", "renew"} {
				request.Operation = operation
				// 缩短当前租期，确保本次续租确实延长到注入值。
				if _, err := pool.Exec(ctx, `UPDATE project_agents SET lease_until=clock_timestamp()+interval '2 seconds' WHERE id=$1`, p.Agent.ID); err != nil {
					t.Fatal(err)
				}
				before = databaseNow()
				data, err := repo.ProjectRuntime(ctx, src, request)
				if err != nil {
					t.Fatal(operation, err)
				}
				checkDuration(before)
				raw, err := json.Marshal(data)
				if err != nil {
					t.Fatal(err)
				}
				var response struct {
					LeaseSeconds    int `json:"lease_seconds"`
					ControlReceipts int `json:"control_receipts"`
				}
				if err := json.Unmarshal(raw, &response); err != nil || response.LeaseSeconds != tc.seconds || response.ControlReceipts != 1 {
					t.Fatalf("%s 响应租期不匹配: %s, %v", operation, raw, err)
				}
			}
			var state string
			if err := pool.QueryRow(ctx, `SELECT state FROM agent_runs WHERE id=$1`, request.RunID).Scan(&state); err != nil || state != "running" {
				t.Fatal("started 未进入 running", state, err)
			}

			if _, err := pool.Exec(ctx, `UPDATE project_agents SET lease_until=clock_timestamp() WHERE id=$1`, p.Agent.ID); err != nil {
				t.Fatal(err)
			}
			expired := leaseUntil()
			for _, operation := range []string{"renew", "started"} {
				request.Operation = operation
				if _, err := repo.ProjectRuntime(ctx, src, request); !errors.Is(err, projectagent.ErrLeaseLost) {
					t.Fatalf("到期后 %s 应拒绝: %v", operation, err)
				}
				if !leaseUntil().Equal(expired) {
					t.Fatal("被拒绝的续租修改了期限")
				}
			}
			before = databaseNow()
			if err := repo.ScheduleProjectRuns(ctx); err != nil {
				t.Fatal(err)
			}
			checkDuration(before)
			current = runtimeRequest(t, ctx, pool, p.Agent.ID, "started")
			if current.RunID == request.RunID || current.LeaseEpoch != request.LeaseEpoch+1 {
				t.Fatal("过期租约未分配新运行和代次")
			}
			if err := pool.QueryRow(ctx, `SELECT state FROM agent_runs WHERE id=$1`, request.RunID).Scan(&state); err != nil || state != "lost" {
				t.Fatal("过期运行未标记 lost", state, err)
			}
			allocated = leaseUntil()
			request.Operation = "renew"
			if _, err := repo.ProjectRuntime(ctx, src, request); !errors.Is(err, projectagent.ErrLeaseLost) {
				t.Fatalf("旧代次续租应拒绝: %v", err)
			}
			if !leaseUntil().Equal(allocated) {
				t.Fatal("旧运行修改了新租约")
			}
		})
	}
}

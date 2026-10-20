package store_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type deliveryQueryTrace struct {
	mu  sync.Mutex
	sql string
}

func (q *deliveryQueryTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "WITH candidates AS MATERIALIZED") && strings.Contains(data.SQL, "r.command_attempts") {
		q.mu.Lock()
		q.sql = data.SQL
		q.mu.Unlock()
	}
	return ctx
}
func (*deliveryQueryTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestProjectStopDeliveryUsesPendingIndexWithConfirmedHistory(t *testing.T) {
	h := deliveryHarness(t)
	project, pending := insertDeliveryRun(t, h, h.src, "finished")
	// 已确认历史属于同一 Agent 和节点，不能靠节点过滤避开这些行。
	if _, err := h.pool.Exec(h.ctx, `INSERT INTO agent_runs
 (id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason,ended_at,end_reason,stop_requested_at,stop_acked_at)
 SELECT gen_random_uuid(),$1,$2,$3,i,'finished','openai-codex','test','history',clock_timestamp(),'idle',clock_timestamp(),clock_timestamp()
 FROM generate_series(2,20001) i`, h.owner, project.Agent.ID, h.src.NodeID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, `UPDATE project_agents SET lease_epoch=20001 WHERE id=$1`, project.Agent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(h.ctx, `ANALYZE agent_runs`); err != nil {
		t.Fatal(err)
	}
	trace := &deliveryQueryTrace{}
	config := h.pool.Config()
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(h.ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	commands, err := store.New(pool).ClaimProjectRunCommands(h.ctx, protocol.BodyProjectRunStop)
	if err != nil || len(commands) != 1 || commands[0].Command.RunID != pending {
		t.Fatalf("历史影响了待停止领取: %+v %v", commands, err)
	}
	trace.mu.Lock()
	query := trace.sql
	trace.mu.Unlock()
	if query == "" {
		t.Fatal("未捕获真实停止领取查询")
	}
	if _, err := h.pool.Exec(h.ctx, `UPDATE agent_runs SET command_next_at=clock_timestamp()-interval '1 second' WHERE id=$1`, pending); err != nil {
		t.Fatal(err)
	}
	var plan []byte
	if err := h.pool.QueryRow(h.ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plan), `"Index Name": "agent_runs_stop_due"`) {
		t.Fatalf("确认历史未通过待停止部分索引排除: %s", plan)
	}
	var stats []struct {
		ExecutionTime float64 `json:"Execution Time"`
		Plan          struct {
			Rows float64 `json:"Actual Rows"`
			Hits float64 `json:"Shared Hit Blocks"`
		} `json:"Plan"`
	}
	if err := json.Unmarshal(plan, &stats); err != nil || len(stats) != 1 {
		t.Fatalf("无效执行计划: %s %v", plan, err)
	}
	t.Logf("20000 条同节点已确认历史，实际领取查询使用 agent_runs_stop_due；返回 %.0f 行，命中 %.0f 块，执行 %.3fms", stats[0].Plan.Rows, stats[0].Plan.Hits, stats[0].ExecutionTime)
}

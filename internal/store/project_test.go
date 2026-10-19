package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/projectagent"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func projectFixture(t *testing.T) (context.Context, *pgxpool.Pool, *store.Store, string, projectagent.Project) {
	t.Helper()
	ctx := t.Context()
	pool := dbtest.Open(t)
	repo := store.New(pool)
	emp := mustEmployee(t, ctx, pool, "project-owner", "项目员工")
	p, err := repo.CreateProject(ctx, emp.ID, projectagent.CreateInput{Title: "Baton 开发"})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, pool, repo, emp.ID, p
}

func TestProjectIdentityOwnershipAndConstraints(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	other := mustEmployee(t, ctx, pool, "other", "其他员工")
	if p.ID == p.Agent.ID || p.Agent.ID == p.Conversation.ID || p.Version != 1 || p.Conversation.LastSeq != 0 {
		t.Fatalf("初始身份无效: %+v", p)
	}
	for _, status := range []string{"paused", "archived", "active"} {
		title, goal, provider, model := "新标题", "目标", "openai-codex", "chosen-model"
		updated, err := repo.PatchProject(ctx, owner, p.ID, projectagent.Patch{Title: &title, Goal: &goal, Status: &status, Provider: &provider, Model: &model})
		if err != nil {
			t.Fatal(err)
		}
		if updated.ID != p.ID || updated.Agent.ID != p.Agent.ID || updated.Conversation.ID != p.Conversation.ID || updated.Status != status || updated.Agent.Model != model {
			t.Fatal("修改改变了身份或漏存字段")
		}
	}
	if _, err := repo.Project(ctx, other.ID, p.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨员工读取: %v", err)
	}
	if _, err := repo.PatchProject(ctx, other.ID, p.ID, projectagent.Patch{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨员工修改: %v", err)
	}
	items, err := repo.ListProjects(ctx, other.ID, "", 100)
	if err != nil || len(items) != 0 {
		t.Fatalf("列表泄漏: %v", err)
	}
	for _, title := range []string{"", " ", "标题\n", strings.Repeat("中", 201)} {
		if _, err := repo.CreateProject(ctx, owner, projectagent.CreateInput{Title: title}); !errors.Is(err, projectagent.ErrInvalid) {
			t.Fatalf("接受非法标题: %v", err)
		}
	}
	var columns []string
	rows, err := pool.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' ORDER BY ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, column)
	}
	rows.Close()
	if strings.Join(columns, ",") != "id,employee_id,title,goal,status,version,created_at,updated_at" {
		t.Fatalf("Project 列: %v", columns)
	}
	invalidSQL := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO project_agents(id,employee_id,project_id) VALUES(gen_random_uuid(),$1,$2)`, []any{other.ID, p.ID}},
		{`INSERT INTO conversations(id,employee_id,agent_id) VALUES(gen_random_uuid(),$1,$2)`, []any{other.ID, p.Agent.ID}},
		{`INSERT INTO conversation_events(conversation_id,employee_id,seq,kind,payload) VALUES($1,$2,1,'input','{}')`, []any{p.Conversation.ID, other.ID}},
		{`INSERT INTO conversations(id,employee_id,agent_id) VALUES(gen_random_uuid(),$1,$2)`, []any{owner, p.Agent.ID}},
		{`UPDATE project_agents SET lease_run_id=gen_random_uuid() WHERE id=$1`, []any{p.Agent.ID}},
	}
	for _, q := range invalidSQL {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err == nil {
			t.Fatalf("数据库接受非法关系: %s", q.sql)
		}
	}
}

func TestProjectMessagesConcurrentReplayAndOffline(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	const writers = 12
	records := make([]projectagent.Message, writers)
	errs := make([]error, writers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range writers {
		wg.Go(func() {
			<-start
			records[i], errs[i] = repo.AcceptProjectMessage(ctx, owner, p.ID, projectagent.MessageInput{ClientMessageID: "message-1", Content: "离线消息 <script>"})
		})
	}
	close(start)
	wg.Wait()
	for i := range writers {
		if errs[i] != nil || records[i] != records[0] {
			t.Fatalf("并发重发 %d: %+v, %v", i, records[i], errs[i])
		}
	}
	if _, err := repo.AcceptProjectMessage(ctx, owner, p.ID, projectagent.MessageInput{ClientMessageID: "message-1", Content: "不同正文"}); !errors.Is(err, projectagent.ErrMessageConflict) {
		t.Fatalf("不同内容: %v", err)
	}
	for _, n := range []int{65536, 65537} {
		_, err := repo.AcceptProjectMessage(ctx, owner, p.ID, projectagent.MessageInput{ClientMessageID: fmt.Sprint(n), Content: strings.Repeat("x", n)})
		if n == 65536 && err != nil || n == 65537 && !errors.Is(err, projectagent.ErrTooLarge) {
			t.Fatalf("边界 %d: %v", n, err)
		}
	}
	var inputs, events, nodes int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_agent_input_queue),(SELECT count(*) FROM conversation_events),(SELECT count(*) FROM nodes)`).Scan(&inputs, &events, &nodes); err != nil {
		t.Fatal(err)
	}
	if inputs != 2 || events != 0 || nodes != 0 {
		t.Fatalf("队列 %d，事件 %d，节点 %d", inputs, events, nodes)
	}
	if _, err := repo.AcceptProjectMessage(ctx, owner, p.ID, projectagent.MessageInput{ClientMessageID: "escaped", Content: "x" + strings.Repeat("\n", 65535)}); !errors.Is(err, projectagent.ErrTooLarge) {
		t.Fatalf("编码后队列上限: %v", err)
	}
}

func TestProjectMemoryConcurrentUserAndAgent(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	entryID, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	first, err := repo.WriteProjectMemory(ctx, owner, p.ID, entryID, projectagent.MemoryWrite{Title: "决定", Content: "原文", Author: "user"})
	if err != nil || first.Revision != 1 {
		t.Fatalf("创建记忆: %+v %v", first, err)
	}
	seedProjectEvents(t, ctx, pool, owner, p, 1, "assistant", `{"format":"pi-ai/1","message":{"role":"assistant","content":[]}}`)
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]projectagent.Memory, 2)
	errs := make([]error, 2)
	for i, author := range []string{"user", "agent"} {
		wg.Go(func() {
			<-start
			seq := int64(1)
			results[i], errs[i] = repo.WriteProjectMemory(ctx, owner, p.ID, entryID, projectagent.MemoryWrite{Title: "决定", Content: author, Author: author, ExpectedRevision: 1, SourceSeq: &seq})
		})
	}
	close(start)
	wg.Wait()
	wins, conflicts := 0, 0
	for i, err := range errs {
		if err == nil {
			wins++
			if results[i].Revision != 2 {
				t.Fatal("成功修订号错误")
			}
			continue
		}
		var conflict *projectagent.MemoryConflict
		if !errors.As(err, &conflict) || conflict.Current == nil || conflict.Current.Revision != 2 || conflict.Current.Content == []string{"user", "agent"}[i] {
			t.Fatalf("冲突未返回胜者: %#v %v", conflict, err)
		}
		conflicts++
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("成功 %d，冲突 %d", wins, conflicts)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_memory_revisions WHERE entry_id=$1`, entryID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("修订数 %d: %v", count, err)
	}
	var old string
	if err := pool.QueryRow(ctx, `SELECT content FROM project_memory_revisions WHERE entry_id=$1 AND revision=1`, entryID).Scan(&old); err != nil || old != "原文" {
		t.Fatal("历史被覆盖")
	}
	for _, table := range []string{"conversation_events", "project_memory_revisions"} {
		for _, verb := range []string{"UPDATE " + table + " SET created_at=now()", "DELETE FROM " + table} {
			_, err := pool.Exec(ctx, verb)
			var pgerr *pgconn.PgError
			if !errors.As(err, &pgerr) || pgerr.Code != "23514" || !strings.Contains(pgerr.Message, "只允许追加") {
				t.Fatalf("追加约束 %s: %v", verb, err)
			}
		}
	}
}

func TestProjectMemoryConcurrentCreationAndScope(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	other := mustEmployee(t, ctx, pool, "another", "另一员工")
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = repo.WriteProjectMemory(ctx, owner, p.ID, id, projectagent.MemoryWrite{Title: "并发创建", Content: fmt.Sprint(i), Author: "user"})
		})
	}
	wg.Wait()
	wins := 0
	for _, err := range errs {
		var conflict *projectagent.MemoryConflict
		if err == nil {
			wins++
		} else if !errors.As(err, &conflict) || conflict.Current == nil || conflict.Current.Revision != 1 {
			t.Fatalf("创建冲突: %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("创建成功 %d 次", wins)
	}
	if _, err := repo.ProjectMemory(ctx, other.ID, p.ID, id); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨员工记忆: %v", err)
	}
	if _, err := repo.WriteProjectMemory(ctx, other.ID, p.ID, id, projectagent.MemoryWrite{Title: "越权", Author: "agent", ExpectedRevision: 1}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨员工写入: %v", err)
	}
	p2, err := repo.CreateProject(ctx, owner, projectagent.CreateInput{Title: "另一项目"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ProjectMemory(ctx, owner, p2.ID, id); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("跨项目记忆: %v", err)
	}
	seq := int64(99)
	if _, err := repo.WriteProjectMemory(ctx, owner, p.ID, id, projectagent.MemoryWrite{Title: "无效来源", Author: "agent", ExpectedRevision: 1, SourceSeq: &seq}); !errors.Is(err, projectagent.ErrInvalid) {
		t.Fatalf("无效来源: %v", err)
	}
}

func seedProjectEvents(t *testing.T, ctx context.Context, pool *pgxpool.Pool, owner string, p projectagent.Project, count int, kind, payload string) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for i := 1; i <= count; i++ {
		if _, err := tx.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,client_event_id,payload) VALUES($1,$2,$3,$4,$5,$6)`, p.Conversation.ID, i, owner, kind, fmt.Sprint(i), payload); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE conversations SET next_seq=$2 WHERE id=$1`, p.Conversation.ID, count+1); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestProjectEventsPaginationKeepsOriginalPayload(t *testing.T) {
	ctx, pool, repo, owner, p := projectFixture(t)
	payload := `{"format":"pi-ai/1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"` + strings.Repeat("中", 35000) + `","thinkingSignature":"签名"}],"usage":{"totalTokens":12},"stopReason":"stop"}}`
	seedProjectEvents(t, ctx, pool, owner, p, 3, "assistant", payload)
	after := int64(0)
	for i := 1; i <= 3; i++ {
		page, err := repo.ProjectEvents(ctx, owner, p.ID, after, 100)
		if err != nil || len(page.Events) != 1 || page.Events[0].Seq != int64(i) || page.LastSeq != 3 || page.HasMore != (i < 3) {
			t.Fatalf("分页 %d: %+v %v", i, page, err)
		}
		var got, want any
		if err := json.Unmarshal(page.Events[0].Payload, &got); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(payload), &want); err != nil {
			t.Fatal(err)
		}
		a, _ := json.Marshal(got)
		b, _ := json.Marshal(want)
		if string(a) != string(b) {
			t.Fatal("原始模型字段丢失")
		}
		after = page.NextAfterSeq
	}
	page, err := repo.ProjectEvents(ctx, owner, p.ID, after, 100)
	if err != nil || len(page.Events) != 0 || page.HasMore || page.NextAfterSeq != 3 {
		t.Fatalf("末页: %+v %v", page, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO conversation_events(conversation_id,employee_id,seq,kind,payload) VALUES($1,$2,4,'assistant',$3)`, p.Conversation.ID, owner, `{"text":"`+strings.Repeat("x", 163840)+`"}`); err == nil {
		t.Fatal("数据库接受超限事件")
	}
}

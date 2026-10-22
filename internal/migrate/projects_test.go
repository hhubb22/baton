package migrate

import (
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func seedProject(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	execOK(t, pool, `INSERT INTO projects(id,employee_id,title) VALUES($1,$2,'项目')`, testProject, testEmployee)
	execOK(t, pool, `INSERT INTO project_agents(id,employee_id,project_id,provider,model) VALUES($1,$2,$3,'pi','model-a')`, testAgent, testEmployee, testProject)
	execOK(t, pool, `INSERT INTO conversations(id,employee_id,agent_id) VALUES($1,$2,$3)`, testConversation, testEmployee, testAgent)
}

func TestProjectHistoryAndDeferredMemoryForeignKey(t *testing.T) {
	pool := migratedTestDB(t)
	seedIdentity(t, pool)
	seedProject(t, pool)
	ctx := t.Context()
	execOK(t, pool, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES($1,1,$2,'input','{}')`, testConversation, testEmployee)
	execFails(t, pool, "23514", `UPDATE conversation_events SET payload='{"changed":true}'`)
	execFails(t, pool, "23514", `DELETE FROM conversation_events`)
	execFails(t, pool, "23503", `UPDATE project_agents SET employee_id=$1`, testOtherEmployee)
	const memory = "60000000-0000-4000-8000-000000000001"
	const entrySQL = `INSERT INTO project_memory_entries(id,employee_id,project_id,title,current_revision) VALUES($1,$2,$3,'记忆',1)`
	execFails(t, pool, "23503", entrySQL, memory, testEmployee, testProject)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, entrySQL, memory, testEmployee, testProject); err != nil {
		t.Fatal("当前修订外键未延迟到提交", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO project_memory_revisions(entry_id,employee_id,revision,content,author) VALUES($1,$2,1,'内容','agent')`, memory, testEmployee); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	execFails(t, pool, "23514", `UPDATE project_memory_revisions SET content='changed'`)
	execFails(t, pool, "23514", `DELETE FROM project_memory_revisions`)
}

func TestProjectInputTypesAndPayloadLimits(t *testing.T) {
	pool := migratedTestDB(t)
	seedIdentity(t, pool)
	seedProject(t, pool)
	const inputSQL = `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash)
		VALUES($1,$2,$3,$4,$5::jsonb,decode(repeat('00',32),'hex'))`
	for _, kind := range []string{"user_message", "attention_answer", "memory_updated", "project_updated", "thread_reply", "turn_ended", "thread_message_failed"} {
		execOK(t, pool, inputSQL, testEmployee, testAgent, kind, kind, `{}`)
	}
	for _, kind := range []string{"task_result", "user_task_result", "unrecognized"} {
		execFails(t, pool, "23514", inputSQL, testEmployee, testAgent, kind, kind, `{}`)
	}
	execFails(t, pool, "23503", inputSQL, testOtherEmployee, testAgent, "user_message", "foreign", `{}`)
	execFails(t, pool, "23505", inputSQL, testEmployee, testAgent, "user_message", "user_message", `{}`)
	for i, tc := range []struct {
		kind              string
		size              int
		command, accepted bool
	}{
		{"thread_reply", 40000, false, true}, {"thread_reply", 41000, false, false},
		{"thread_message_failed", 40000, false, true}, {"thread_message_failed", 41000, false, false},
		{"turn_ended", 4000, false, true}, {"turn_ended", 4100, false, false},
		{"turn_ended", 70000, true, true}, {"turn_ended", 74000, true, false},
		{"memory_updated", 1000, false, true}, {"memory_updated", 1024, false, false},
		{"project_updated", 4000, false, true}, {"project_updated", 4096, false, false},
		{"attention_answer", 32000, false, true}, {"attention_answer", 32768, false, false},
		{"user_message", 74000, false, false},
	} {
		t.Run(fmt.Sprintf("%s/%d/command=%t", tc.kind, tc.size, tc.command), func(t *testing.T) {
			payload := `{"data":"` + strings.Repeat("x", tc.size) + `"}`
			if tc.command {
				payload = `{"command_result":` + payload + `}`
			}
			key := fmt.Sprintf("size:%d", i)
			if tc.accepted {
				execOK(t, pool, inputSQL, testEmployee, testAgent, tc.kind, key, payload)
			} else {
				execFails(t, pool, "23514", inputSQL, testEmployee, testAgent, tc.kind, key, payload)
			}
		})
	}
}

package migrate

import (
	"io/fs"
	"testing"
	"testing/fstest"

	"baton/migrations"
)

func TestThreadsUpgradeKeepsTaskModelAndEmployeeForeignKeys(t *testing.T) {
	pool := openTestDB(t)
	ctx := t.Context()
	before := fstest.MapFS{}
	names, err := Versions()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "0025" {
			continue
		}
		raw, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = &fstest.MapFile{Data: raw}
	}
	if err = upFS(ctx, pool, before); err != nil {
		t.Fatal(err)
	}
	const owner = "00000000-0000-4000-8000-000000000001"
	const other = "00000000-0000-4000-8000-000000000002"
	const node = "10000000-0000-4000-8000-000000000001"
	const thread = "20000000-0000-4000-8000-000000000001"
	if _, err = pool.Exec(ctx, `INSERT INTO employees(id,username,display_name,auth_source,external_subject,must_change_password,created_at,updated_at) VALUES($1,'thread-old','Old','directory','old',false,now(),now()),($2,'thread-other','Other','directory','other',false,now(),now())`, owner, other); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO nodes(id,employee_id,display_name,system_name,capabilities,registration_seq,registered_at,credential_version) VALUES($1,$2,'Desk','linux','{pi}',nextval('node_registration_seq'),now(),1)`, node, owner); err != nil {
		t.Fatal(err)
	}
	if err = Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"tasks", "sessions", "executions", "threads", "thread_messages", "thread_turns", "thread_replies", "thread_events", "thread_outbox", "thread_reports"} {
		assertInSchema(t, ctx, pool, name)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE id=$1`, node).Scan(&count); err != nil || count != 1 {
		t.Fatal("old node lost", count, err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO threads(id,employee_id,client_thread_id,request_hash,node_id,agent_type,working_directory,created_by) VALUES($1,$2,'upgrade',decode(repeat('00',32),'hex'),$3,'pi','/src','employee')`, thread, owner, node); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO thread_messages(id,employee_id,thread_id,client_message_id,sender,content) VALUES('30000000-0000-4000-8000-000000000001',$1,$2,'foreign','employee','no')`, other, thread); err == nil {
		t.Fatal("cross-employee message accepted")
	}
	if _, err = pool.Exec(ctx, `INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action) VALUES($1,$2,$3,'40000000-0000-4000-8000-000000000001','open')`, other, thread, node); err == nil {
		t.Fatal("cross-employee command accepted")
	}
	fingerprint := schemaFingerprint(t, ctx, pool)
	if err = Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if fingerprint != schemaFingerprint(t, ctx, pool) {
		t.Fatal("repeat migration changed schema")
	}
}

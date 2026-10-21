package migrate

import (
	"io/fs"
	"testing"
	"testing/fstest"

	"baton/migrations"
)

func TestProjectsUpgradeExistingDatabaseAndRepeat(t *testing.T) {
	pool := openTestDB(t)
	ctx := t.Context()
	before := fstest.MapFS{}
	names, err := Versions()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "0016" {
			continue
		}
		body, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = &fstest.MapFile{Data: body}
	}
	if err := upFS(ctx, pool, before); err != nil {
		t.Fatal(err)
	}
	const employee = "00000000-0000-4000-8000-000000000001"
	const node = "10000000-0000-4000-8000-000000000001"
	if _, err := pool.Exec(ctx, `INSERT INTO employees(id,username,display_name,auth_source,external_subject,must_change_password,created_at,updated_at)
        VALUES($1,'existing','已有员工','directory','existing',false,now(),now())`, employee); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO nodes(id,employee_id,display_name,system_name,capabilities,registration_seq,registered_at,credential_version,revoked_at)
        VALUES($1,$2,'已吊销设备','linux','{}',nextval('node_registration_seq'),now(),1,now())`, node, employee); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO employee_settings(employee_id,default_device_node_id,updated_at) VALUES($1,$2,'2026-01-01T00:00:00Z')`, employee, node); err != nil {
		t.Fatal(err)
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var defaultNode string
	if err := pool.QueryRow(ctx, `SELECT default_device_node_id::text FROM employee_settings WHERE employee_id=$1`, employee).Scan(&defaultNode); err != nil || defaultNode != node {
		t.Fatalf("已有默认设备变化: %s %v", defaultNode, err)
	}
	fingerprint := schemaFingerprint(t, ctx, pool)
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if fingerprint != schemaFingerprint(t, ctx, pool) {
		t.Fatal("重复迁移改变结构或版本")
	}
	for _, table := range []string{"projects", "project_agents", "conversations", "conversation_events", "project_agent_input_queue", "project_memory_entries", "project_memory_revisions", "agent_runs"} {
		if !tableExists(t, ctx, pool, table) {
			t.Fatalf("缺少 %s", table)
		}
		assertInSchema(t, ctx, pool, table)
	}
	assertFunctionSchema(t, ctx, pool, "reject_project_history_mutation")
	assertTriggerSchema(t, ctx, pool, "conversation_events_append_only")
	assertTriggerSchema(t, ctx, pool, "project_memory_revisions_append_only")
}

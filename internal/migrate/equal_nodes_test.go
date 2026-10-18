package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"baton/migrations"
)

func TestEqualNodesUpgradePreservesDefaultsAndFillsMissing(t *testing.T) {
	pool := openTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var version int
	if err := pool.QueryRow(ctx, `SELECT current_setting('server_version_num')::int`).Scan(&version); err != nil || version < 170000 || version >= 180000 {
		t.Fatalf("需要 PostgreSQL 17，版本 %d: %v", version, err)
	}
	// 用真实的前十四个迁移构造升级前的库。
	before := fstest.MapFS{}
	names, err := Versions()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "0015" {
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
	employee := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
	nodeID := func(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
	for i := 1; i <= 6; i++ {
		_, err := pool.Exec(ctx, `INSERT INTO employees
   (id, username, display_name, auth_source, external_subject, must_change_password, created_at, updated_at)
   VALUES ($1, $2, $2, 'directory', $2, false, now(), now())`, employee(i), fmt.Sprintf("employee%d", i))
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []struct {
		id, owner int
		role      string
		revoked   bool
	}{
		{1, 1, "pc", false}, {2, 1, "pc", false},
		{3, 2, "pc", true}, {4, 2, "ubuntu", false},
		{5, 3, "ubuntu", true}, {6, 3, "ubuntu", false}, {7, 3, "ubuntu", false},
		{8, 4, "ubuntu", false}, {9, 5, "ubuntu", true},
	} {
		_, err := pool.Exec(ctx, `INSERT INTO nodes
   (id, employee_id, display_name, system_name, role, capabilities, registration_seq, registered_at, credential_version, revoked_at)
   VALUES ($1, $2, '设备', 'linux', $3, '{}', nextval('node_registration_seq'), now(), 1,
    CASE WHEN $4::boolean THEN now() ELSE NULL END)`, nodeID(n.id), employee(n.owner), n.role, n.revoked)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, setting := range []struct{ owner, node int }{{1, 2}, {2, 3}, {3, 0}, {5, 0}, {6, 0}} {
		var target any
		if setting.node != 0 {
			target = nodeID(setting.node)
		}
		_, err := pool.Exec(ctx, `INSERT INTO employee_settings (employee_id, default_pc_node_id, updated_at)
   VALUES ($1,$2,'2026-01-01T00:00:00Z')`, employee(setting.owner), target)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for owner, wantNode := range []int{2, 3, 6, 8, 0, 0} {
		var got string
		var updated time.Time
		if err := pool.QueryRow(ctx, `SELECT COALESCE(default_device_node_id::text, ''), updated_at
   FROM employee_settings WHERE employee_id=$1`, employee(owner+1)).Scan(&got, &updated); err != nil {
			t.Fatal(err)
		}
		want := ""
		if wantNode != 0 {
			want = nodeID(wantNode)
		}
		if got != want {
			t.Fatalf("员工 %d 默认值 %s，预期 %s", owner+1, got, want)
		}
		if owner < 2 && updated.Format("2006-01-02") != "2026-01-01" {
			t.Fatal("已有默认设备的更新时间被修改")
		}
	}
	fingerprint := schemaFingerprint(t, ctx, pool)
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if schemaFingerprint(t, ctx, pool) != fingerprint {
		t.Fatal("重复迁移改写了结构或版本")
	}
	var legacy int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema()
  AND ((table_name='nodes' AND column_name='role') OR (table_name='employee_settings' AND column_name='default_pc_node_id'))`).Scan(&legacy); err != nil || legacy != 0 {
		t.Fatalf("旧列仍存在: %d, %v", legacy, err)
	}
	// 重复迁移不会重算手动选择，也不会补选已吊销的默认设备。
	if _, err := pool.Exec(ctx, `UPDATE employee_settings SET default_device_node_id=$2 WHERE employee_id=$1`, employee(3), nodeID(7)); err != nil {
		t.Fatal(err)
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := pool.QueryRow(ctx, `SELECT default_device_node_id::text FROM employee_settings WHERE employee_id=$1`, employee(3)).Scan(&got); err != nil || got != nodeID(7) {
		t.Fatalf("重复迁移重算默认设备: %s, %v", got, err)
	}

	for _, tc := range []struct {
		name, owner   string
		reportVersion int
		report        string
		accepted      bool
	}{
		{"有效报告", employee(1), 1, `{"runtime":true}`, true},
		{"跨员工", employee(2), 1, `{}`, false},
		{"版本非正数", employee(1), 0, `{}`, false},
		{"报告超限", employee(1), 1, `{"data":"` + strings.Repeat("x", 65536) + `"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO node_runtime_reports (node_id,employee_id,report_version,reported_at,report)
    VALUES ($1,$2,$3,now(),$4::jsonb) ON CONFLICT(node_id) DO UPDATE SET employee_id=EXCLUDED.employee_id,
    report_version=EXCLUDED.report_version,report=EXCLUDED.report`, nodeID(1), tc.owner, tc.reportVersion, tc.report)
			if (err == nil) != tc.accepted {
				t.Fatalf("报告写入结果不符合预期: %v", err)
			}
		})
	}
}

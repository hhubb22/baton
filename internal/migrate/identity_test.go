package migrate

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	testEmployee      = "00000000-0000-4000-8000-000000000001"
	testOtherEmployee = "00000000-0000-4000-8000-000000000002"
	testNode          = "10000000-0000-4000-8000-000000000001"
	testProject       = "20000000-0000-4000-8000-000000000001"
	testAgent         = "30000000-0000-4000-8000-000000000001"
	testConversation  = "40000000-0000-4000-8000-000000000001"
	testThread        = "50000000-0000-4000-8000-000000000001"
)

func seedIdentity(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	execOK(t, pool, `INSERT INTO employees(id,username,display_name,auth_source,external_subject,must_change_password,created_at,updated_at)
		VALUES($1,'owner','员工','directory','owner',false,now(),now()),($2,'other','另一员工','directory','other',false,now(),now())`, testEmployee, testOtherEmployee)
	execOK(t, pool, `INSERT INTO nodes(id,employee_id,display_name,system_name,capabilities,registration_seq,registered_at,credential_version)
		VALUES($1,$2,'设备','linux','{pi}',nextval('node_registration_seq'),now(),1)`, testNode, testEmployee)
}

func TestIdentityConstraintsAndNodeOwnership(t *testing.T) {
	pool := migratedTestDB(t)
	seedIdentity(t, pool)
	execOK(t, pool, `INSERT INTO employee_settings(employee_id,default_device_node_id,updated_at) VALUES($1,$2,now())`, testEmployee, testNode)
	execFails(t, pool, "23503", `INSERT INTO employee_settings(employee_id,default_device_node_id,updated_at) VALUES($1,$2,now())`, testOtherEmployee, testNode)
	execFails(t, pool, "23514", `UPDATE employees SET auth_source='local' WHERE id=$1`, testEmployee)
	execOK(t, pool, `UPDATE employees SET auth_source='local',external_subject=NULL,password_hash='$argon2id$test' WHERE id=$1`, testEmployee)
	execFails(t, pool, "23505", `UPDATE employees SET username='owner' WHERE id=$1`, testOtherEmployee)
	execOK(t, pool, `INSERT INTO login_sessions(id,employee_id,token_hash,csrf_hash,created_at,expires_at)
		VALUES($1,$2,decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),now(),now()+interval '1 hour')`, testThread, testEmployee)
	execFails(t, pool, "23514", `UPDATE login_sessions SET csrf_hash=decode('00','hex') WHERE id=$1`, testThread)
	execFails(t, pool, "23503", `UPDATE login_sessions SET employee_id=$1 WHERE id=$2`, testProject, testThread)
	for _, tc := range []struct {
		name, owner string
		version     int
		report      string
		code        string
	}{
		{"有效报告", testEmployee, 1, `{"runtime":true}`, ""},
		{"跨员工", testOtherEmployee, 1, `{}`, "23503"},
		{"版本非正数", testEmployee, 0, `{}`, "23514"},
		{"报告超限", testEmployee, 1, `{"data":"` + strings.Repeat("x", 65536) + `"}`, "23514"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const sql = `INSERT INTO node_runtime_reports(node_id,employee_id,report_version,reported_at,report)
				VALUES($1,$2,$3,now(),$4::jsonb) ON CONFLICT(node_id) DO UPDATE
				SET employee_id=EXCLUDED.employee_id,report_version=EXCLUDED.report_version,report=EXCLUDED.report`
			if tc.code == "" {
				execOK(t, pool, sql, testNode, tc.owner, tc.version, tc.report)
			} else {
				execFails(t, pool, tc.code, sql, testNode, tc.owner, tc.version, tc.report)
			}
		})
	}
}

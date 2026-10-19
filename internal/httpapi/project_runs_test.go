package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/projectagent"
	"baton/internal/store"
)

func TestProjectRunAPIAuthorizationAndRetry(t *testing.T) {
	pool := dbtest.Open(t)
	srv := httptest.NewTLSServer(newAPI(t, pool, &bytes.Buffer{}))
	t.Cleanup(srv.Close)
	alice, bob, anonymous := tlsClient(t, srv), tlsClient(t, srv), tlsClient(t, srv)
	const password = "project-run-api-password"
	owner := createEmployee(t, pool, "alice", "员工甲", password)
	createEmployee(t, pool, "bob", "员工乙", password)
	aCSRF := loginFor(t, alice, srv.URL, "alice", password)
	bCSRF := loginFor(t, bob, srv.URL, "bob", password)
	p, err := store.New(pool).CreateProject(t.Context(), owner.ID, projectagent.CreateInput{Title: "重试项目"})
	if err != nil {
		t.Fatal(err)
	}
	base := srv.URL + "/api/v1/projects/" + p.ID
	for _, action := range []string{"retry", "stop"} {
		endpoint := base + "/" + action
		for _, tc := range []struct {
			client  *browser
			csrf    string
			method  string
			suffix  string
			payload any
			status  int
		}{
			{anonymous, "", "POST", "", struct{}{}, 401},
			{alice, "", "POST", "", struct{}{}, 403},
			{bob, bCSRF, "POST", "", struct{}{}, 404},
			{alice, aCSRF, "GET", "", nil, 405},
			{alice, aCSRF, "POST", "?employee_id=other", struct{}{}, 400},
			{alice, aCSRF, "POST", "", map[string]string{"employee_id": owner.ID}, 400},
			{alice, aCSRF, "POST", "", nil, 400},
			{alice, aCSRF, "POST", "", json.RawMessage("null"), 400},
		} {
			status, body := projectRequest(t, tc.client, tc.method, endpoint+tc.suffix, tc.csrf, tc.payload)
			if status != tc.status {
				t.Fatalf("%s %s: %d %s", tc.method, action, status, body)
			}
		}
	}
	if _, err := pool.Exec(t.Context(), `UPDATE conversations SET state='needs_attention',failure_count=3,attention_reason='模型错误',next_attempt_at=now()+interval '15 minutes' WHERE id=$1`, p.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	if status, body := projectRequest(t, alice, "POST", base+"/retry", aCSRF, struct{}{}); status != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("重试: %d %s", status, body)
	}
	var reset bool
	if err := pool.QueryRow(t.Context(), `SELECT state='active' AND failure_count=0 AND attention_reason IS NULL AND next_attempt_at IS NULL FROM conversations WHERE id=$1`, p.Conversation.ID).Scan(&reset); err != nil || !reset {
		t.Fatalf("重试未重置失败状态: %v", err)
	}
	if status, body := projectRequest(t, alice, "POST", base+"/stop", aCSRF, struct{}{}); status != 200 {
		t.Fatalf("停止空闲项目: %d %s", status, body)
	}
}

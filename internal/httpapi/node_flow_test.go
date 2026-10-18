package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/node"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestNodeEnrollmentRegisterAndDefaultPC(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	aliceClient := tlsClient(t, srv)
	bobClient := tlsClient(t, srv)
	const password = "node-flow-password-001"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	bob := createEmployee(t, pool, "bob", "Bob", password)
	aliceCSRF := loginFor(t, aliceClient, srv.URL, "alice", password)
	bobCSRF := loginFor(t, bobClient, srv.URL, "bob", password)

	noCSRF, noCSRFBody, _ := postJSON(t, aliceClient, srv.URL+"/api/v1/node-enrollments", origin, "", map[string]any{})
	if noCSRF != http.StatusForbidden || strings.Contains(noCSRFBody, password) {
		t.Fatalf("缺少 CSRF 的注册凭据状态 %d", noCSRF)
	}

	enrollment := issueEnrollment(t, aliceClient, srv.URL, aliceCSRF)
	if enrollment.EnrollmentToken == "" || enrollment.EnrollmentID == "" {
		t.Fatal("注册凭据响应不完整")
	}
	until := time.Until(enrollment.ExpiresAt)
	if until < 8*time.Minute || until > 12*time.Minute {
		t.Fatalf("注册凭据有效期是 %s", until)
	}
	secrets := []string{password, aliceCSRF, bobCSRF, enrollment.EnrollmentToken}

	status, body, _ := postJSON(t, bobClient, srv.URL+"/api/v1/nodes/register", "", "", map[string]any{
		"enrollment_token": enrollment.EnrollmentToken,
		"display_name":     "Desk",
		"system":           "linux",
		"role":             "pc",
		"capabilities":     []string{"start"},
		"employee_id":      bob.ID,
	})
	if status != http.StatusBadRequest || !strings.Contains(body, `"code":"invalid_request"`) {
		t.Fatalf("正文指定员工的状态 %d", status)
	}
	assertNoSecrets(t, "指定员工的响应", body, secrets...)
	if countNodes(t, pool, alice.ID) != 0 || countNodes(t, pool, bob.ID) != 0 {
		t.Fatal("被拒绝的注册写入了节点")
	}

	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", map[string]any{
		"enrollment_token": enrollment.EnrollmentToken,
		"display_name":     "Desk",
		"system":           "invalid",
		"role":             "root",
		"capabilities":     []string{},
	})
	if status != http.StatusBadRequest || !strings.Contains(body, `"code":"invalid_node"`) {
		t.Fatalf("非法系统状态 %d", status)
	}
	if countNodes(t, pool, alice.ID) != 0 {
		t.Fatal("非法系统消耗了注册凭据")
	}

	queryToken := "query-secret-token-should-not-log"
	secrets = append(secrets, queryToken)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register?enrollment_token="+queryToken, "", "", map[string]any{
		"enrollment_token": enrollment.EnrollmentToken,
		"display_name":     "Desk",
		"system":           "linux",
		"role":             "pc",
		"capabilities":     []string{"start"},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("URL 参数状态 %d", status)
	}
	assertNoSecrets(t, "URL 参数响应", body, secrets...)
	if countNodes(t, pool, alice.ID) != 0 {
		t.Fatal("URL 中的参数消耗了注册凭据")
	}

	expireEnrollment(t, pool, enrollment.EnrollmentID)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(enrollment.EnrollmentToken, "Desk", "pc", []string{"start"}))
	if status != http.StatusUnauthorized || !strings.Contains(body, `"code":"enrollment_expired"`) {
		t.Fatalf("过期注册凭据状态 %d", status)
	}
	assertNoSecrets(t, "过期响应", body, secrets...)
	if countNodes(t, pool, alice.ID) != 0 {
		t.Fatal("过期凭据写入了节点")
	}

	fresh := issueEnrollment(t, aliceClient, srv.URL, aliceCSRF)
	secrets = append(secrets, fresh.EnrollmentToken)
	status, body, _ = postJSON(t, bobClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(fresh.EnrollmentToken, "Alice Early", "pc", []string{"start", "input"}))
	if status != http.StatusOK {
		t.Fatalf("注册状态 %d", status)
	}
	var early node.Identity
	if err := json.Unmarshal([]byte(body), &early); err != nil {
		t.Fatal(err)
	}
	if early.EmployeeID != alice.ID || early.EmployeeID == bob.ID || early.DisplayName != "Alice Early" || early.Role != "pc" || early.RegistrationSeq < 1 {
		t.Fatal("注册结果的归属或序号不正确")
	}
	if early.Credential.Token == "" || early.Credential.Version != 1 {
		t.Fatal("注册没有签发连接凭据")
	}
	credUntil := time.Until(early.Credential.ExpiresAt)
	if credUntil < 29*24*time.Hour || credUntil > 31*24*time.Hour {
		t.Fatalf("连接凭据有效期是 %s", credUntil)
	}
	secrets = append(secrets, early.Credential.Token)
	assertNoSecrets(t, "注册响应", body, password)
	if strings.Contains(body, password) || strings.Contains(body, fresh.EnrollmentToken) {
		t.Fatal("注册响应包含口令或注册凭据")
	}
	if defaultPC(t, pool, alice.ID) != early.NodeID {
		t.Fatal("第一台 PC 没有保存为默认值")
	}
	assertCredentialHash(t, pool, early)

	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(fresh.EnrollmentToken, "Again", "pc", []string{}))
	if status != http.StatusUnauthorized || !strings.Contains(body, `"code":"enrollment_used"`) {
		t.Fatalf("重复使用注册凭据状态 %d", status)
	}
	if countNodes(t, pool, alice.ID) != 1 {
		t.Fatal("重复使用注册凭据产生了新节点")
	}

	secondEnroll := issueEnrollment(t, aliceClient, srv.URL, aliceCSRF)
	secrets = append(secrets, secondEnroll.EnrollmentToken)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(secondEnroll.EnrollmentToken, "Alice Later", "pc", []string{"delegate"}))
	if status != http.StatusOK {
		t.Fatalf("第二台 PC 注册状态 %d", status)
	}
	var later node.Identity
	if err := json.Unmarshal([]byte(body), &later); err != nil {
		t.Fatal(err)
	}
	secrets = append(secrets, later.Credential.Token)
	if later.NodeID == early.NodeID || later.RegistrationSeq <= early.RegistrationSeq {
		t.Fatal("第二台 PC 没有得到新的身份和更晚的序号")
	}
	if defaultPC(t, pool, alice.ID) != early.NodeID {
		t.Fatal("新增节点改变了默认设备")
	}

	bobEnroll := issueEnrollment(t, bobClient, srv.URL, bobCSRF)
	secrets = append(secrets, bobEnroll.EnrollmentToken)
	status, body, _ = postJSON(t, bobClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(bobEnroll.EnrollmentToken, "Bob PC", "pc", []string{"start"}))
	if status != http.StatusOK {
		t.Fatalf("Bob 注册状态 %d", status)
	}
	var bobNode node.Identity
	if err := json.Unmarshal([]byte(body), &bobNode); err != nil {
		t.Fatal(err)
	}
	secrets = append(secrets, bobNode.Credential.Token)
	if bobNode.EmployeeID != bob.ID || defaultPC(t, pool, bob.ID) != bobNode.NodeID {
		t.Fatal("Bob 的节点归属或默认设备不正确")
	}

	status, body = putJSON(t, aliceClient, srv.URL+"/api/v1/me/default-pc", origin, aliceCSRF, map[string]string{"node_id": bobNode.NodeID})
	if status != http.StatusForbidden || !strings.Contains(body, `"code":"forbidden"`) {
		t.Fatalf("跨员工修改默认设备状态 %d", status)
	}
	assertNoSecrets(t, "跨员工响应", body, secrets...)
	if defaultPC(t, pool, alice.ID) != early.NodeID || defaultPC(t, pool, bob.ID) != bobNode.NodeID {
		t.Fatal("被拒绝的跨员工修改改变了默认设备")
	}

	status, body = putJSON(t, aliceClient, srv.URL+"/api/v1/me/default-pc", origin, "", map[string]string{"node_id": later.NodeID})
	if status != http.StatusForbidden {
		t.Fatalf("缺少 CSRF 的默认设备修改状态 %d", status)
	}
	if defaultPC(t, pool, alice.ID) != early.NodeID {
		t.Fatal("缺少 CSRF 时默认设备被修改")
	}

	status, body = putJSON(t, aliceClient, srv.URL+"/api/v1/me/default-pc", origin, aliceCSRF, map[string]string{"node_id": later.NodeID})
	if status != http.StatusOK {
		t.Fatalf("修改默认设备状态 %d", status)
	}
	var saved node.SavedDefault
	if err := json.Unmarshal([]byte(body), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.NodeID != later.NodeID || saved.DisplayName != "Alice Later" || saved.RegistrationSeq != later.RegistrationSeq || saved.LegacyNodeID != saved.NodeID {
		t.Fatalf("响应没有返回实际保存的节点: %+v", saved)
	}
	if defaultPC(t, pool, alice.ID) != saved.NodeID || savedDisplay(t, pool, alice.ID) != saved.DisplayName {
		t.Fatal("数据库中的默认设备与响应不一致")
	}

	ubuntuEnroll := issueEnrollment(t, aliceClient, srv.URL, aliceCSRF)
	secrets = append(secrets, ubuntuEnroll.EnrollmentToken)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(ubuntuEnroll.EnrollmentToken, "Alice Ubuntu", "ubuntu", []string{}))
	if status != http.StatusOK {
		t.Fatalf("Ubuntu 节点注册状态 %d", status)
	}
	var ubuntu node.Identity
	if err := json.Unmarshal([]byte(body), &ubuntu); err != nil {
		t.Fatal(err)
	}
	secrets = append(secrets, ubuntu.Credential.Token)
	if defaultPC(t, pool, alice.ID) != later.NodeID {
		t.Fatal("Ubuntu 节点改变了默认设备")
	}
	status, body = putJSON(t, aliceClient, srv.URL+"/api/v1/me/default-device", origin, aliceCSRF, map[string]string{"node_id": ubuntu.NodeID})
	if status != http.StatusOK {
		t.Fatalf("把 Ubuntu 设为默认设备的状态 %d", status)
	}
	if defaultPC(t, pool, alice.ID) != ubuntu.NodeID {
		t.Fatal("Ubuntu 节点没有保存为默认设备")
	}

	thirdEnroll := issueEnrollment(t, aliceClient, srv.URL, aliceCSRF)
	secrets = append(secrets, thirdEnroll.EnrollmentToken)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(thirdEnroll.EnrollmentToken, "Alice Third", "pc", []string{"start"}))
	if status != http.StatusOK {
		t.Fatalf("第三台 PC 注册状态 %d", status)
	}
	var third node.Identity
	if err := json.Unmarshal([]byte(body), &third); err != nil {
		t.Fatal(err)
	}
	secrets = append(secrets, third.Credential.Token)
	if defaultPC(t, pool, alice.ID) != ubuntu.NodeID {
		t.Fatal("手动选择后的新节点改变了默认设备")
	}

	unknown := strings.Repeat("a", 43)
	status, body, _ = postJSON(t, aliceClient, srv.URL+"/api/v1/nodes/register", "", "", registerBody(unknown, "Nope", "pc", []string{}))
	if status != http.StatusUnauthorized || !strings.Contains(body, `"code":"invalid_enrollment"`) {
		t.Fatalf("未知注册凭据状态 %d", status)
	}
	assertNoSecrets(t, "服务日志", logs.String(), secrets...)
}

func loginFor(t *testing.T, client *browser, base, username, password string) string {
	t.Helper()
	status, body, _ := postJSON(t, client, base+"/api/v1/login", origin, "", map[string]string{
		"username": username,
		"password": password,
	})
	if status != http.StatusOK {
		t.Fatalf("登录状态 %d", status)
	}
	return mustCSRF(t, body)
}

type enrollmentResponse struct {
	EnrollmentID    string    `json:"enrollment_id"`
	EnrollmentToken string    `json:"enrollment_token"`
	ExpiresAt       time.Time `json:"expires_at"`
}

func issueEnrollment(t *testing.T, client *browser, base, csrf string) enrollmentResponse {
	t.Helper()
	status, body, setCookie := postJSON(t, client, base+"/api/v1/node-enrollments", origin, "", map[string]any{}, csrf)
	if status != http.StatusOK {
		t.Fatalf("领取注册凭据状态 %d", status)
	}
	var out enrollmentResponse
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(setCookie, out.EnrollmentToken) {
		t.Fatal("注册凭据被写入 Cookie")
	}
	return out
}

func registerBody(token, name, role string, caps []string) map[string]any {
	return map[string]any{
		"enrollment_token": token,
		"display_name":     name,
		"system":           "linux",
		"role":             role,
		"capabilities":     caps,
	}
}

func putJSON(t *testing.T, client *browser, rawURL, origin, csrf string, payload any) (int, string) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPut, rawURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if csrf != "" {
		req.Header.Set(auth.CSRFHeader, csrf)
	}
	resp, err := client.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(got)
}

func expireEnrollment(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tag, err := pool.Exec(ctx, `
		UPDATE node_enrollments
		SET created_at = now() - interval '2 minutes',
		    expires_at = now() - interval '1 minute'
		WHERE id = $1::uuid`, id)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatal("没有更新注册凭据的有效期")
	}
}

func countNodes(t *testing.T, pool *pgxpool.Pool, employeeID string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM nodes WHERE employee_id = $1::uuid`, employeeID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func defaultPC(t *testing.T, pool *pgxpool.Pool, employeeID string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var id string
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(default_device_node_id::text, '')
		FROM employee_settings WHERE employee_id = $1::uuid`, employeeID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func savedDisplay(t *testing.T, pool *pgxpool.Pool, employeeID string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var name string
	if err := pool.QueryRow(ctx, `
		SELECT n.display_name
		FROM employee_settings es
		JOIN nodes n ON n.id = es.default_device_node_id
		WHERE es.employee_id = $1::uuid`, employeeID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	return name
}

func assertCredentialHash(t *testing.T, pool *pgxpool.Pool, ident node.Identity) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var n int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM node_credentials
		WHERE id = $1::uuid AND node_id = $2::uuid AND revoked_at IS NULL`,
		ident.Credential.ID, ident.NodeID).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("数据库没有保存可吊销的 credential_id")
	}
	var blob string
	err = pool.QueryRow(ctx, `
		SELECT id::text || node_id::text || employee_id::text || version::text || expires_at::text
		FROM node_credentials WHERE id = $1::uuid`, ident.Credential.ID).Scan(&blob)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(blob, ident.Credential.Token) || strings.Count(ident.Credential.Token, ".") != 2 {
		t.Fatal("数据库保存了连接凭据明文，或返回的不是 JWT")
	}
}

func TestNodeStatusIsEmployeeScoped(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	aliceClient := tlsClient(t, srv)
	bobClient := tlsClient(t, srv)
	const password = "node-status-password-1"
	createEmployee(t, pool, "alice", "Alice", password)
	createEmployee(t, pool, "bob", "Bob", password)
	aliceCSRF := loginFor(t, aliceClient, srv.URL, "alice", password)
	bobCSRF := loginFor(t, bobClient, srv.URL, "bob", password)
	aliceNode := registerIdent(t, aliceClient, srv.URL, aliceCSRF, "Alice Desk")
	bobNode := registerIdent(t, bobClient, srv.URL, bobCSRF, "Bob Desk")

	status, body := getText(t, tlsClient(t, srv), srv.URL+"/api/v1/nodes")
	if status != http.StatusUnauthorized {
		t.Fatalf("未登录查询状态 %d", status)
	}
	status, body = getText(t, aliceClient, srv.URL+"/api/v1/nodes")
	if status != http.StatusOK || !strings.Contains(body, aliceNode.NodeID) || strings.Contains(body, bobNode.NodeID) || strings.Contains(body, `"executable":true`) {
		t.Fatalf("本人节点列表不正确: %d %s", status, body)
	}
	if !strings.Contains(body, `"online":false`) || !strings.Contains(body, `"synced":false`) || !strings.Contains(body, `"last_contact_at":null`) || !strings.Contains(body, `"status_updated_at":null`) {
		t.Fatalf("未连接节点的状态字段不正确: %s", body)
	}
	status, body = getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+aliceNode.NodeID)
	if status != http.StatusOK || !strings.Contains(body, `"executable":false`) || !strings.Contains(body, aliceNode.NodeID) {
		t.Fatalf("本人节点详情不正确: %d %s", status, body)
	}
	status, body = getText(t, aliceClient, srv.URL+"/api/v1/nodes/"+bobNode.NodeID)
	if status != http.StatusForbidden || strings.Contains(body, bobNode.NodeID) || !strings.Contains(body, "不能查看该节点") {
		t.Fatalf("查看他人节点状态 %d %s", status, body)
	}
	status, _ = getText(t, aliceClient, srv.URL+"/api/v1/nodes/not-a-uuid")
	if status != http.StatusBadRequest {
		t.Fatalf("非法节点标识状态 %d", status)
	}
	if strings.Contains(logs.String(), aliceNode.Credential.Token) || strings.Contains(logs.String(), password) {
		t.Fatal("状态查询日志包含凭据或口令")
	}
}

func registerIdent(t *testing.T, client *browser, base, csrf, name string) node.Identity {
	t.Helper()
	enrollment := issueEnrollment(t, client, base, csrf)
	status, body, _ := postJSON(t, client, base+"/api/v1/nodes/register", "", "", registerBody(enrollment.EnrollmentToken, name, "pc", []string{"start"}))
	if status != http.StatusOK {
		t.Fatalf("注册状态 %d", status)
	}
	var ident node.Identity
	if err := json.Unmarshal([]byte(body), &ident); err != nil || ident.NodeID == "" {
		t.Fatal(err)
	}
	return ident
}

func getText(t *testing.T, client *browser, rawURL string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(body)
}

func TestEqualNodesDefaultDeviceCompatibilityAndRouting(t *testing.T) {
	pool := dbtest.Open(t)
	api := newAPI(t, pool, &bytes.Buffer{})
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	const password = "equal-nodes-password-001"
	alice := createEmployee(t, pool, "alice", "Alice", password)
	csrf := loginFor(t, client, srv.URL, "alice", password)
	var nodes []node.Identity
	for _, role := range []string{"ubuntu", "pc", "", "unused-value"} {
		enrollment := issueEnrollment(t, client, srv.URL, csrf)
		request := registerBody(enrollment.EnrollmentToken, "设备", role, []string{"pi", "start"})
		if role == "" {
			delete(request, "role")
		}
		status, body, _ := postJSON(t, client, srv.URL+"/api/v1/nodes/register", "", "", request)
		if status != http.StatusOK {
			t.Fatalf("role=%q 注册失败: %d %s", role, status, body)
		}
		var ident node.Identity
		if err := json.Unmarshal([]byte(body), &ident); err != nil {
			t.Fatal(err)
		}
		// 旧版 batond 要求注册响应中有 pc 或 ubuntu，随后仍会发送 node.sync.role。
		if ident.Role != "pc" {
			t.Fatalf("缺少旧版注册兼容值: %q", ident.Role)
		}
		nodes = append(nodes, ident)
	}
	if defaultPC(t, pool, alice.ID) != nodes[0].NodeID {
		t.Fatal("首个 Ubuntu 节点没有成为默认设备")
	}
	for i, endpoint := range []string{"default-device", "default-pc"} {
		status, body := putJSON(t, client, srv.URL+"/api/v1/me/"+endpoint, origin, csrf, map[string]string{"node_id": nodes[i+1].NodeID})
		var saved node.SavedDefault
		if err := json.Unmarshal([]byte(body), &saved); err != nil {
			t.Fatal(err)
		}
		if status != http.StatusOK || saved.NodeID != nodes[i+1].NodeID || saved.LegacyNodeID != saved.NodeID {
			t.Fatalf("%s 保存或兼容响应失败: %d %s", endpoint, status, body)
		}
	}
	resp, err := client.http.Get(srv.URL + "/api/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Nodes         []map[string]any `json:"nodes"`
		DefaultPC     json.RawMessage  `json:"default_pc"`
		DefaultDevice json.RawMessage  `json:"default_device"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || len(list.Nodes) != len(nodes) || len(list.DefaultDevice) == 0 || !bytes.Equal(list.DefaultDevice, list.DefaultPC) {
		t.Fatalf("列表兼容响应不一致: %s", raw)
	}
	for _, view := range list.Nodes {
		if _, ok := view["role"]; ok {
			t.Fatal("列表仍然包含 role")
		}
	}
	status, body, _ := postJSON(t, client, srv.URL+"/api/v1/tasks", origin, "", map[string]any{"request_id": "default-device-routing", "description": "检查节点", "agent_type": "pi"}, csrf)
	if status != http.StatusOK {
		t.Fatalf("默认设备任务失败: %d %s", status, body)
	}
	var accepted struct {
		Target string `json:"target_node_id"`
	}
	if err := json.Unmarshal([]byte(body), &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.Target != nodes[2].NodeID {
		t.Fatalf("任务没有发往无 role 的默认设备: %s", body)
	}
}

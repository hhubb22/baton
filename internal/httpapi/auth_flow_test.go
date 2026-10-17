package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5/pgxpool"
)

const origin = "https://baton.example"

func TestLoginMeLogoutOnTLS(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)

	const (
		username = "alice"
		password = "plain-password-should-not-be-stored-001"
		display  = "Alice Person"
	)
	createEmployee(t, pool, username, display, password)

	wrongStatus, wrongBody, wrongCookie := postJSON(t, client, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": username,
		"password": password + "-wrong",
	})
	if wrongStatus != http.StatusUnauthorized || !strings.Contains(wrongBody, `"code":"invalid_credentials"`) {
		t.Fatalf("错误口令状态 %d", wrongStatus)
	}
	if wrongCookie != "" {
		t.Fatal("错误口令仍设置了会话 Cookie")
	}
	if countActiveSessions(t, pool, username) != 0 {
		t.Fatal("错误口令写入了会话")
	}
	assertNoSecrets(t, "错误口令响应", wrongBody, password)

	status, body, setCookie := postJSON(t, client, srv.URL+"/api/v1/login", origin, "baton_session=attacker-token", map[string]string{
		"username": username,
		"password": password,
	})
	if status != http.StatusOK {
		t.Fatalf("登录状态 %d", status)
	}
	var login struct {
		Employee struct {
			ID                 string `json:"id"`
			Username           string `json:"username"`
			DisplayName        string `json:"display_name"`
			AuthSource         string `json:"auth_source"`
			MustChangePassword bool   `json:"must_change_password"`
		} `json:"employee"`
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.Unmarshal([]byte(body), &login); err != nil {
		t.Fatal(err)
	}
	if login.Employee.Username != username || login.Employee.DisplayName != display || login.Employee.AuthSource != "local" || !login.Employee.MustChangePassword {
		t.Fatal("登录响应中的身份不正确")
	}
	if login.CSRFToken == "" {
		t.Fatal("登录响应缺少 CSRF 令牌")
	}
	token := cookieValue(t, setCookie)
	if token == "attacker-token" || strings.Contains(body, token) || strings.Contains(body, password) || strings.Contains(body, "password_hash") {
		t.Fatal("登录响应泄露了会话令牌、口令或摘要")
	}
	assertCookieFlags(t, setCookie, token)
	if me := getJSON(t, client, srv.URL+"/api/v1/me"); me.Employee.Username != username || me.Employee.DisplayName != display || strings.Contains(me.Raw, "Bob") {
		t.Fatal("本人身份查询结果不正确")
	}
	assertSessionStoredAsDigest(t, pool, token, login.CSRFToken, password)
	replayStatus := replayCookie(t, srv, "attacker-token")
	if replayStatus != http.StatusUnauthorized {
		t.Fatalf("预置会话令牌状态 %d", replayStatus)
	}

	logoutStatus := postEmpty(t, client, srv.URL+"/api/v1/logout", origin, login.CSRFToken)
	if logoutStatus != http.StatusNoContent {
		t.Fatalf("退出状态 %d", logoutStatus)
	}
	meAfter := getRaw(t, client, srv.URL+"/api/v1/me")
	if meAfter.StatusCode != http.StatusUnauthorized || !strings.Contains(meAfter.Body, `"code":"unauthenticated"`) {
		t.Fatalf("退出后状态 %d", meAfter.StatusCode)
	}
	if countActiveSessions(t, pool, username) != 0 {
		t.Fatal("退出后会话仍然有效")
	}
	if replayCookie(t, srv, token) != http.StatusUnauthorized {
		t.Fatal("退出后的会话令牌仍被接受")
	}
	assertNoSecrets(t, "服务日志", logs.String(), password, token, login.CSRFToken, "attacker-token")
}

func TestCSRFAndOrigin(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	const password = "correct-horse-battery-1"
	createEmployee(t, pool, "alice", "Alice Person", password)
	status, body, _ := postJSON(t, client, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": password,
	})
	if status != http.StatusOK {
		t.Fatalf("登录状态 %d", status)
	}
	csrf := mustCSRF(t, body)
	token := sessionToken(t, client, srv.URL)

	noCSRF := postEmpty(t, client, srv.URL+"/api/v1/logout", origin, "")
	if noCSRF != http.StatusForbidden {
		t.Fatalf("缺少 CSRF 的退出状态 %d", noCSRF)
	}
	if getRaw(t, client, srv.URL+"/api/v1/me").StatusCode != http.StatusOK {
		t.Fatal("缺少 CSRF 时会话被注销")
	}
	badOrigin := postEmpty(t, client, srv.URL+"/api/v1/logout", "https://evil.example", csrf)
	if badOrigin != http.StatusForbidden {
		t.Fatalf("错误 Origin 的退出状态 %d", badOrigin)
	}
	missingOrigin := postEmpty(t, client, srv.URL+"/api/v1/logout", "", csrf)
	if missingOrigin != http.StatusForbidden {
		t.Fatalf("缺少 Origin 的退出状态 %d", missingOrigin)
	}
	otherStatus, _, _ := postJSON(t, client, srv.URL+"/api/v1/login", "https://evil.example", "", map[string]string{
		"username": "alice",
		"password": password,
	})
	if otherStatus != http.StatusForbidden {
		t.Fatalf("错误 Origin 的登录状态 %d", otherStatus)
	}
	extraStatus, extraBody, _ := postJSON(t, client, srv.URL+"/api/v1/login", origin, "", map[string]any{
		"username":    "alice",
		"password":    password,
		"employee_id": "00000000-0000-4000-8000-000000000099",
	})
	if extraStatus != http.StatusBadRequest {
		t.Fatalf("多余身份字段状态 %d", extraStatus)
	}
	assertNoSecrets(t, "多余字段响应", extraBody, password)
	if getRaw(t, client, srv.URL+"/api/v1/me").StatusCode != http.StatusOK {
		t.Fatal("被拒绝的写操作注销了会话")
	}
	assertNoSecrets(t, "服务日志", logs.String(), password, token, csrf)
}

func TestWriteGuardsBindCSRFToSession(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	srv := httptest.NewTLSServer(newAPI(t, pool, logs))
	t.Cleanup(srv.Close)
	const password = "initial-secret-for-guards-001"
	createEmployee(t, pool, "alice", "Alice", password)
	first, second := tlsClient(t, srv), tlsClient(t, srv)
	status, body, _ := postJSON(t, first, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice", "password": password,
	})
	if status != http.StatusOK {
		t.Fatal("第一个会话登录失败")
	}
	firstCSRF := mustCSRF(t, body)
	status, body, _ = postJSON(t, second, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice", "password": password,
	})
	if status != http.StatusOK {
		t.Fatal("第二个会话登录失败")
	}
	secondCSRF := mustCSRF(t, body)
	for _, path := range []string{"/api/v1/logout", "/api/v1/me/password", "/api/v1/node-enrollments"} {
		for _, tc := range []struct{ name, origin, csrf string }{
			{"missing_origin", "", firstCSRF},
			{"wrong_origin", "https://evil.example", firstCSRF},
			{"missing_csrf", origin, ""},
			{"wrong_csrf", origin, "synthetic-wrong-csrf-token"},
			{"other_session_csrf", origin, secondCSRF},
		} {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				status, body, _ := postJSON(t, first, srv.URL+path, tc.origin, "", map[string]string{
					"current_password": password, "new_password": "replacement-for-guards-002",
				}, tc.csrf)
				if status != http.StatusForbidden {
					t.Fatalf("写请求应被拒绝，状态 %d", status)
				}
				assertNoSecrets(t, "拒绝响应", body, password, firstCSRF, secondCSRF)
			})
		}
	}
	if countActiveSessions(t, pool, "alice") != 2 {
		t.Fatal("被拒绝的写请求修改了会话")
	}
	if getRaw(t, first, srv.URL+"/api/v1/me").StatusCode != http.StatusOK ||
		getRaw(t, second, srv.URL+"/api/v1/me").StatusCode != http.StatusOK {
		t.Fatal("被拒绝的写请求使已有会话失效")
	}
	assertNoSecrets(t, "服务日志", logs.String(), password, firstCSRF, secondCSRF)
}

func replayCookie(t *testing.T, srv *httptest.Server, token string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Cookie", auth.SessionCookieName+"="+token)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func TestExpiredSessionRejected(t *testing.T) {
	pool := dbtest.Open(t)
	api := newAPI(t, pool, &bytes.Buffer{})
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	const password = "correct-horse-battery-2"
	createEmployee(t, pool, "alice", "Alice Person", password)
	status, _, _ := postJSON(t, client, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": password,
	})
	if status != http.StatusOK {
		t.Fatalf("登录状态 %d", status)
	}
	token := sessionToken(t, client, srv.URL)
	sum := sha256.Sum256([]byte(token))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tag, err := pool.Exec(ctx, `UPDATE login_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, sum[:])
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("更新过期时间失败 rows=%d err=%v", tag.RowsAffected(), err != nil)
	}
	got := getRaw(t, client, srv.URL+"/api/v1/me")
	if got.StatusCode != http.StatusUnauthorized || !strings.Contains(got.Body, `"code":"session_expired"`) {
		t.Fatalf("过期会话状态 %d", got.StatusCode)
	}
	assertNoSecrets(t, "过期响应", got.Body, password, token)
}

func TestCrossAccountIdentityRejected(t *testing.T) {
	pool := dbtest.Open(t)
	api := newAPI(t, pool, &bytes.Buffer{})
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	client := tlsClient(t, srv)
	alice := createEmployee(t, pool, "alice", "Alice Person", "correct-horse-battery-3")
	bob := createEmployee(t, pool, "bob", "Bob Person", "correct-horse-battery-4")
	status, body, _ := postJSON(t, client, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": "correct-horse-battery-3",
	})
	if status != http.StatusOK {
		t.Fatalf("登录状态 %d", status)
	}
	me := getJSON(t, client, srv.URL+"/api/v1/me")
	if me.Employee.ID != alice.ID || me.Employee.Username != "alice" || strings.Contains(me.Raw, "Bob") || strings.Contains(me.Raw, bob.ID) {
		t.Fatal("本人查询返回了其他员工")
	}
	self := getRaw(t, client, srv.URL+"/api/v1/employees/"+alice.ID)
	if self.StatusCode != http.StatusOK || !strings.Contains(self.Body, "Alice Person") || strings.Contains(self.Body, "Bob Person") {
		t.Fatal("读取本人资料失败")
	}
	other := getRaw(t, client, srv.URL+"/api/v1/employees/"+bob.ID)
	if other.StatusCode != http.StatusForbidden || strings.Contains(other.Body, "Bob") || strings.Contains(other.Body, bob.Username) || strings.Contains(other.Body, bob.DisplayName) {
		t.Fatal("跨账号访问未被拒绝")
	}
	unknown := getRaw(t, client, srv.URL+"/api/v1/employees/00000000-0000-4000-8000-000000000099")
	if unknown.StatusCode != http.StatusForbidden || strings.Contains(unknown.Body, "Bob") {
		t.Fatal("其他员工标识未被拒绝")
	}
	_ = body
}

func TestInitialPasswordChange(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	first := tlsClient(t, srv)
	second := tlsClient(t, srv)
	const (
		initial = "initial-secret-001"
		next    = "replaced-secret-002"
	)
	createEmployee(t, pool, "alice", "Alice Person", initial)
	status, body, _ := postJSON(t, first, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": initial,
	})
	if status != http.StatusOK || !strings.Contains(body, `"must_change_password":true`) {
		t.Fatal("初始登录未要求更换口令")
	}
	csrf := mustCSRF(t, body)
	status2, body2, _ := postJSON(t, second, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": initial,
	})
	if status2 != http.StatusOK {
		t.Fatal("第二个会话登录失败")
	}
	_ = body2
	badCurrent, badBody, _ := postJSON(t, first, srv.URL+"/api/v1/me/password", origin, "", map[string]string{
		"current_password": "not-the-current-1",
		"new_password":     next,
	}, csrf)
	if badCurrent != http.StatusUnauthorized {
		t.Fatalf("错误的当前口令状态 %d", badCurrent)
	}
	assertNoSecrets(t, "错误当前口令响应", badBody, initial, next, "not-the-current-1")
	if getRaw(t, first, srv.URL+"/api/v1/me").StatusCode != http.StatusOK {
		t.Fatal("口令更换失败时注销了会话")
	}
	shortStatus, shortBody, _ := postJSON(t, first, srv.URL+"/api/v1/me/password", origin, "", map[string]string{
		"current_password": initial,
		"new_password":     "tiny",
	}, csrf)
	if shortStatus != http.StatusBadRequest || strings.Contains(shortBody, "tiny") || strings.Contains(shortBody, initial) {
		t.Fatal("无效新口令的响应不正确")
	}
	changed, changedBody, _ := postJSON(t, first, srv.URL+"/api/v1/me/password", origin, "", map[string]string{
		"current_password": initial,
		"new_password":     next,
	}, csrf)
	if changed != http.StatusOK || !strings.Contains(changedBody, `"must_change_password":false`) {
		t.Fatalf("更换口令状态 %d", changed)
	}
	assertNoSecrets(t, "更换口令响应", changedBody, initial, next)
	if getRaw(t, first, srv.URL+"/api/v1/me").StatusCode != http.StatusUnauthorized {
		t.Fatal("更换口令后原会话仍有效")
	}
	if getRaw(t, second, srv.URL+"/api/v1/me").StatusCode != http.StatusUnauthorized {
		t.Fatal("更换口令后其他会话仍有效")
	}
	oldStatus, _, _ := postJSON(t, tlsClient(t, srv), srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": initial,
	})
	if oldStatus != http.StatusUnauthorized {
		t.Fatal("旧口令仍可登录")
	}
	fresh := tlsClient(t, srv)
	newStatus, newBody, _ := postJSON(t, fresh, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": next,
	})
	if newStatus != http.StatusOK || !strings.Contains(newBody, `"must_change_password":false`) || !strings.Contains(newBody, "Alice Person") {
		t.Fatal("新口令登录未返回本人身份")
	}
	assertNoSecrets(t, "服务日志", logs.String(), initial, next, csrf)
}

func TestSecureCookieOnPlainHTTPUsesFormalRules(t *testing.T) {
	pool := dbtest.Open(t)
	api := newAPI(t, pool, &bytes.Buffer{})
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	const password = "correct-horse-battery-5"
	createEmployee(t, pool, "alice", "Alice Person", password)

	formal := &formalJar{}
	client := &http.Client{Jar: formal, Timeout: 30 * time.Second}
	status, body, setCookie := postJSON(t, &browser{http: client, jar: formal}, srv.URL+"/api/v1/login", origin, "", map[string]string{
		"username": "alice",
		"password": password,
	})
	if status != http.StatusOK {
		t.Fatalf("明文登录状态 %d", status)
	}
	token := cookieValue(t, setCookie)
	assertCookieFlags(t, setCookie, token)
	if strings.Contains(body, token) {
		t.Fatal("明文登录响应包含会话令牌")
	}
	me := getRaw(t, &browser{http: client, jar: formal}, srv.URL+"/api/v1/me")
	if me.StatusCode != http.StatusUnauthorized {
		t.Fatalf("正式 Cookie 规则在明文 HTTP 上完成了会话，状态 %d", me.StatusCode)
	}
	if formal.sentSecure {
		t.Fatal("正式 Cookie 客户端在明文请求中发送了 Secure Cookie")
	}

	manual, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	manual.Header.Set("Cookie", auth.SessionCookieName+"="+token)
	resp, err := http.DefaultClient.Do(manual)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("显式带上 Cookie 的明文请求状态 %d", resp.StatusCode)
	}
	csrf := mustCSRF(t, body)
	logout, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/logout", nil)
	if err != nil {
		t.Fatal(err)
	}
	logout.Header.Set("Cookie", auth.SessionCookieName+"="+token)
	logout.Header.Set("Origin", origin)
	denied, err := http.DefaultClient.Do(logout)
	if err != nil {
		t.Fatal(err)
	}
	denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("明文请求缺少 CSRF 时状态 %d", denied.StatusCode)
	}
	logout.Header.Set(auth.CSRFHeader, csrf)
	allowed, err := http.DefaultClient.Do(logout)
	if err != nil {
		t.Fatal(err)
	}
	allowed.Body.Close()
	if allowed.StatusCode != http.StatusNoContent {
		t.Fatalf("明文请求带 CSRF 退出状态 %d", allowed.StatusCode)
	}
}

func TestPathAndQueryDoNotEnterLogs(t *testing.T) {
	pool := dbtest.Open(t)
	logs := &bytes.Buffer{}
	api := newAPI(t, pool, logs)
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	const password = "query-secret-should-stay-out"
	createEmployee(t, pool, "alice", "Alice Person", password)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/login?password="+url.QueryEscape(password), strings.NewReader(`{"username":"alice","password":"wrong-password-11"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	resp, err := tlsClient(t, srv).http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	req, err = http.NewRequest(http.MethodGet, srv.URL+"/api/v1/employees/"+password, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err = tlsClient(t, srv).http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	assertNoSecrets(t, "服务日志", logs.String(), password)
}

type employee struct {
	ID          string
	Username    string
	DisplayName string
}

func createEmployee(t *testing.T, pool *pgxpool.Pool, username, displayName, password string) employee {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	emp, err := admin.CreateLocal(ctx, pool, username, displayName, password)
	if err != nil {
		t.Fatalf("创建员工失败: %s", redact.Scrub(err.Error()))
	}
	var hash string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM employees WHERE username = $1`, username).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if hash == password || !strings.HasPrefix(hash, "$argon2id$") || strings.Contains(hash, password) {
		t.Fatal("数据库中的口令不是 Argon2id 摘要")
	}
	return employee{ID: emp.ID, Username: emp.Username, DisplayName: emp.DisplayName}
}

func newAPI(t *testing.T, pool *pgxpool.Pool, logs io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(logs, nil))
	api, err := httpapi.New(pool, httpapi.Settings{
		Origins:           []string{origin},
		SessionTTL:        time.Hour,
		EnrollmentTTL:     10 * time.Minute,
		NodeCredentialTTL: 30 * 24 * time.Hour,
		Logger:            logger,
	})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

type browser struct {
	http *http.Client
	jar  http.CookieJar
}

func tlsClient(t *testing.T, srv *httptest.Server) *browser {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &browser{
		jar: jar,
		http: &http.Client{
			Jar:     jar,
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					RootCAs:    pool,
					MinVersion: tls.VersionTLS12,
				},
			},
		},
	}
}

func postJSON(t *testing.T, client *browser, rawURL, origin, cookie string, payload any, csrf ...string) (int, string, string) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if len(csrf) > 0 && csrf[0] != "" {
		req.Header.Set(auth.CSRFHeader, csrf[0])
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
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("响应允许了跨源读取")
	}
	return resp.StatusCode, string(got), strings.Join(resp.Header.Values("Set-Cookie"), "\n")
}

func postEmpty(t *testing.T, client *browser, rawURL, origin, csrf string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
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
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

type meResponse struct {
	Raw      string
	Employee struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	} `json:"employee"`
}

func getJSON(t *testing.T, client *browser, rawURL string) meResponse {
	t.Helper()
	got := getRaw(t, client, rawURL)
	if got.StatusCode != http.StatusOK {
		t.Fatalf("查询状态 %d", got.StatusCode)
	}
	var out meResponse
	out.Raw = got.Body
	if err := json.Unmarshal([]byte(got.Body), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

type rawResponse struct {
	StatusCode int
	Body       string
}

func getRaw(t *testing.T, client *browser, rawURL string) rawResponse {
	t.Helper()
	resp, err := client.http.Get(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return rawResponse{StatusCode: resp.StatusCode, Body: string(body)}
}

func mustCSRF(t *testing.T, body string) string {
	t.Helper()
	var payload struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil || payload.CSRFToken == "" {
		t.Fatal("响应缺少 CSRF 令牌")
	}
	return payload.CSRFToken
}

func cookieValue(t *testing.T, setCookie string) string {
	t.Helper()
	resp := &http.Response{Header: http.Header{"Set-Cookie": []string{setCookie}}}
	for _, cookie := range resp.Cookies() {
		if cookie.Name == auth.SessionCookieName && cookie.Value != "" {
			return cookie.Value
		}
	}
	t.Fatal("响应没有会话 Cookie")
	return ""
}

func assertCookieFlags(t *testing.T, setCookie, token string) {
	t.Helper()
	resp := &http.Response{Header: http.Header{"Set-Cookie": []string{setCookie}}}
	cookies := resp.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("Set-Cookie 数量 %d", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != auth.SessionCookieName || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" {
		t.Fatal("会话 Cookie 属性不完整")
	}
	for _, part := range []string{"Secure", "HttpOnly", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(setCookie, part) {
			safe := strings.ReplaceAll(setCookie, token, "[redacted]")
			t.Fatalf("Set-Cookie 缺少 %s: %s", part, safe)
		}
	}
}

func sessionToken(t *testing.T, client *browser, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range client.jar.Cookies(u) {
		if cookie.Name == auth.SessionCookieName {
			return cookie.Value
		}
	}
	t.Fatal("客户端没有会话 Cookie")
	return ""
}

func assertSessionStoredAsDigest(t *testing.T, pool *pgxpool.Pool, token, csrf, password string) {
	t.Helper()
	tokenSum := sha256.Sum256([]byte(token))
	csrfSum := sha256.Sum256([]byte(csrf))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var tokenHash, csrfHash []byte
	var hash string
	err := pool.QueryRow(ctx, `
		SELECT s.token_hash, s.csrf_hash, e.password_hash
		FROM login_sessions s
		JOIN employees e ON e.id = s.employee_id
		WHERE s.token_hash = $1`, tokenSum[:]).Scan(&tokenHash, &csrfHash, &hash)
	if err != nil {
		t.Fatalf("按摘要查找会话失败: %s", redact.Scrub(err.Error()))
	}
	if !bytes.Equal(tokenHash, tokenSum[:]) || !bytes.Equal(csrfHash, csrfSum[:]) {
		t.Fatal("数据库保存的不是令牌摘要")
	}
	var rawTokenCount int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM employees
		WHERE password_hash = $1 OR display_name = $1 OR username = $1`, token).Scan(&rawTokenCount)
	if err != nil {
		t.Fatal(err)
	}
	if rawTokenCount != 0 || strings.Contains(hash, password) || strings.Contains(hash, token) {
		t.Fatal("数据库保存了明文口令或会话令牌")
	}
}

func countActiveSessions(t *testing.T, pool *pgxpool.Pool, username string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var n int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM login_sessions s
		JOIN employees e ON e.id = s.employee_id
		WHERE e.username = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, username).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func assertNoSecrets(t *testing.T, label, text string, secrets ...string) {
	t.Helper()
	cleaned := text
	leaked := false
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(text, secret) {
			leaked = true
			cleaned = strings.ReplaceAll(cleaned, secret, "[redacted]")
		}
	}
	if leaked {
		t.Errorf("%s包含应脱敏的内容", label)
		t.Log(cleaned)
	}
}

type formalJar struct {
	cookies    []*http.Cookie
	sentSecure bool
}

func (j *formalJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	j.cookies = append(j.cookies, cookies...)
}

func (j *formalJar) Cookies(u *url.URL) []*http.Cookie {
	var out []*http.Cookie
	for _, cookie := range j.cookies {
		if cookie.Secure && u.Scheme != "https" {
			continue
		}
		if cookie.Secure {
			j.sentSecure = true
		}
		out = append(out, cookie)
	}
	return out
}

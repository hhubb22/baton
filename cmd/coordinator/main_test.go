package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"baton/internal/auth"
	"baton/internal/db"
	"baton/internal/httpapi"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestUsageWithoutDatabase(t *testing.T) {
	err := run(context.Background(), nil, io.Discard, io.Discard, func(string) string { return "" })
	var coded *exitCode
	if !errors.As(err, &coded) || coded.code != 2 {
		t.Fatal("缺少参数时应返回用法错误")
	}
}

func TestServeRejectsHTTPOriginBeforeDial(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := run(ctx, []string{"serve"}, io.Discard, io.Discard, func(key string) string {
		switch key {
		case "BATON_DATABASE_URL":
			return "postgres://127.0.0.1:1/baton_not_used"
		case "BATON_ALLOWED_ORIGINS":
			return "http://baton.example"
		default:
			return ""
		}
	})
	if err == nil || !strings.Contains(err.Error(), "Origin") {
		t.Fatalf("http Origin 未被拒绝: %s", redact.Scrub(errorText(err)))
	}
	if strings.Contains(err.Error(), "连接数据库失败") {
		t.Fatal("Origin 校验之前连接了数据库")
	}
}

func TestCLIMigrateCreateResetAndServeGuard(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("BATON_TEST_DATABASE_URL"))
	if raw == "" {
		t.Fatal("BATON_TEST_DATABASE_URL 未设置，集成测试不能改用模拟数据库")
	}
	schema := "cli" + strings.ToLower(strings.ReplaceAll(time.Now().UTC().Format("150405.000000"), ".", ""))
	getenv := func(key string) string {
		switch key {
		case "BATON_DATABASE_URL":
			return raw
		case "BATON_DB_SCHEMA":
			return schema
		case "BATON_ALLOWED_ORIGINS":
			return "https://baton.example"
		case "BATON_HTTP_ADDR":
			return "127.0.0.1:0"
		default:
			return ""
		}
	}
	t.Cleanup(func() {
		dropSchema(t, raw, schema)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := run(ctx, []string{"migrate"}, io.Discard, io.Discard, getenv); err != nil {
		t.Fatalf("迁移失败: %s", redact.Scrub(err.Error()))
	}
	if err := run(ctx, []string{"migrate"}, io.Discard, io.Discard, getenv); err != nil {
		t.Fatalf("重复迁移失败: %s", redact.Scrub(err.Error()))
	}

	var stdout, stderr bytes.Buffer
	if err := run(ctx, []string{"admin", "employee", "create", "--username", "cliuser", "--display-name", "CLI User"}, &stdout, &stderr, getenv); err != nil {
		t.Fatalf("创建账号失败: %s", redact.Scrub(err.Error()))
	}
	password := issuedPassword(t, stdout.String())
	if strings.Contains(stderr.String(), password) {
		t.Fatal("创建命令的标准错误包含一次性口令")
	}

	pool := openSchema(t, raw, schema)
	defer pool.Close()
	api, err := httpapi.New(pool, []string{"https://baton.example"}, time.Hour, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(api)
	defer srv.Close()
	body, token := login(t, srv, "cliuser", password)
	if !strings.Contains(body, `"must_change_password":true`) || !strings.Contains(body, "CLI User") {
		t.Fatal("命令创建的账号登录后未返回本人身份")
	}

	stdout.Reset()
	stderr.Reset()
	if err := run(ctx, []string{"admin", "employee", "reset-password", "--username", "cliuser"}, &stdout, &stderr, getenv); err != nil {
		t.Fatalf("重置口令失败: %s", redact.Scrub(err.Error()))
	}
	reset := issuedPassword(t, stdout.String())
	if reset == password || strings.Contains(stderr.String(), reset) || strings.Contains(stderr.String(), password) {
		t.Fatal("重置命令的输出不符合一次性口令的要求")
	}
	if replay(t, srv, token) != http.StatusUnauthorized {
		t.Fatal("重置后原会话仍有效")
	}
	if status := loginStatus(t, srv, "cliuser", password); status != http.StatusUnauthorized {
		t.Fatal("重置后旧口令仍可登录")
	}
	resetBody, _ := login(t, srv, "cliuser", reset)
	if !strings.Contains(resetBody, `"must_change_password":true`) || strings.Contains(resetBody, password) {
		t.Fatal("重置后的登录结果不正确")
	}

	emptySchema := schema + "b"
	t.Cleanup(func() { dropSchema(t, raw, emptySchema) })
	unmigrated := func(key string) string {
		if key == "BATON_DB_SCHEMA" {
			return emptySchema
		}
		return getenv(key)
	}
	serveCtx, serveCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer serveCancel()
	err = run(serveCtx, []string{"serve"}, io.Discard, io.Discard, unmigrated)
	if err == nil || !strings.Contains(err.Error(), "迁移") {
		t.Fatalf("未迁移时 serve 应失败: %s", redact.Scrub(errorText(err)))
	}
}

func issuedPassword(t *testing.T, stdout string) string {
	t.Helper()
	const prefix = "one_time_password="
	for _, line := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(line, prefix) {
			password := strings.TrimPrefix(line, prefix)
			if password == "" {
				t.Fatal("一次性口令为空")
			}
			return password
		}
	}
	t.Fatal("标准输出没有一次性口令")
	return ""
}

func openSchema(t *testing.T, raw, schema string) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, raw, schema)
	if err != nil {
		t.Fatalf("打开测试 schema 失败: %s", redact.Scrub(err.Error()))
	}
	return pool
}

func dropSchema(t *testing.T, raw, schema string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, raw, schema)
	if err != nil {
		t.Errorf("清理前连接失败: %s", redact.Scrub(err.Error()))
		return
	}
	defer pool.Close()
	ident, err := db.QuoteIdent(schema)
	if err != nil {
		t.Errorf("schema 名称无效")
		return
	}
	if _, err := pool.Exec(ctx, "DROP SCHEMA IF EXISTS "+ident+" CASCADE"); err != nil {
		t.Errorf("清理测试 schema 失败: %s", redact.Scrub(err.Error()))
	}
}

func trustedClient(t *testing.T, srv *httptest.Server) *http.Client {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{
		Jar:     jar,
		Timeout: 30 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		}},
	}
}

func login(t *testing.T, srv *httptest.Server, username, password string) (string, string) {
	t.Helper()
	status, body, token := loginWith(t, trustedClient(t, srv), srv, username, password)
	if status != http.StatusOK || token == "" {
		t.Fatalf("登录状态 %d", status)
	}
	if strings.Contains(body, password) {
		t.Fatal("登录响应包含口令")
	}
	return body, token
}

func loginStatus(t *testing.T, srv *httptest.Server, username, password string) int {
	t.Helper()
	status, body, _ := loginWith(t, trustedClient(t, srv), srv, username, password)
	if strings.Contains(body, password) {
		t.Fatal("登录响应包含口令")
	}
	return status
}

func loginWith(t *testing.T, client *http.Client, srv *httptest.Server, username, password string) (int, string, string) {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"username": username, "password": password})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/login", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://baton.example")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var token string
	for _, cookie := range resp.Cookies() {
		if cookie.Name == auth.SessionCookieName {
			token = cookie.Value
		}
	}
	return resp.StatusCode, string(body), token
}

func replay(t *testing.T, srv *httptest.Server, token string) int {
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

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/httpapi"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/privatefiletest"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRegisterUsageDoesNotRequireDatabase(t *testing.T) {
	err := run(context.Background(), nil, io.Discard, io.Discard, func(string) string { return "" })
	var coded *exitCode
	if !errors.As(err, &coded) || coded.code != 2 {
		t.Fatal("缺少参数时应返回用法错误")
	}
	secret := "cli-secret-must-not-appear"
	var stderr bytes.Buffer
	err = run(context.Background(), []string{"register", "--enrollment-token", secret}, io.Discard, &stderr, func(string) string { return "" })
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(stderr.String(), secret) {
		t.Fatal("命令行中的凭据被接受或回显")
	}
	err = run(context.Background(), []string{"register", secret}, io.Discard, &stderr, func(string) string { return "" })
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(stderr.String(), secret) {
		t.Fatal("位置参数中的凭据被接受或回显")
	}
}

func TestRegisterKeepsIdentityAcrossRestart(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	logs := &bytes.Buffer{}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	api, err := httpapi.New(pool, httpapi.Settings{
		Origins:           []string{"https://baton.example"},
		SessionTTL:        time.Hour,
		EnrollmentTTL:     10 * time.Minute,
		NodeCredentialTTL: 30 * 24 * time.Hour,
		Signer:            signer,
		Logger:            slog.New(slog.NewTextHandler(logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	const password = "batond-register-password-1"
	if _, err := admin.CreateLocal(ctx, pool, "alice", "Alice", password); err != nil {
		t.Fatal(err)
	}
	client := trustedClient(t, srv)
	csrf := loginCSRF(t, client, srv.URL, "alice", password)
	enrollment := fetchEnrollment(t, client, srv.URL, csrf)
	caFile := writeCA(t, srv.Certificate())

	looseDir := filepath.Join(t.TempDir(), "loose")
	looseFile := filepath.Join(t.TempDir(), "enroll")
	if err := os.WriteFile(looseFile, []byte(enrollment+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	privatefiletest.MakePublic(t, looseFile)
	var stdout, stderr bytes.Buffer
	err = run(ctx, registerArgs(srv.URL, looseDir, looseFile), &stdout, &stderr, func(string) string { return "" })
	if err == nil || strings.Contains(err.Error(), enrollment) || strings.Contains(stderr.String(), enrollment) || strings.Contains(stdout.String(), enrollment) {
		t.Fatal("权限过宽的凭据文件被接受或凭据被回显")
	}
	if count(t, pool, `SELECT COUNT(*) FROM nodes`) != 0 {
		t.Fatal("失败的注册写入了节点")
	}

	stdout.Reset()
	stderr.Reset()
	err = run(ctx, []string{
		"register", "--coordinator", "http://127.0.0.1:1", "--data-dir", filepath.Join(t.TempDir(), "http"),
		"--display-name", "Desk", "--system", "linux", "--role", "pc",
	}, &stdout, &stderr, func(key string) string {
		if key == "BATON_ENROLLMENT_TOKEN" {
			return enrollment
		}
		return ""
	})
	if err == nil || strings.Contains(err.Error(), enrollment) || strings.Contains(stdout.String()+stderr.String(), enrollment) {
		t.Fatal("明文 Coordinator 地址被接受或凭据被回显")
	}
	if count(t, pool, `SELECT COUNT(*) FROM nodes`) != 0 {
		t.Fatal("明文地址的注册写入了节点")
	}

	dir := filepath.Join(t.TempDir(), "node")
	stdout.Reset()
	stderr.Reset()
	err = run(ctx, registerArgs(srv.URL, dir, ""), &stdout, &stderr, func(key string) string {
		switch key {
		case "BATON_ENROLLMENT_TOKEN":
			return enrollment
		case "BATON_TLS_CA_FILE":
			return caFile
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	combined := stdout.String() + stderr.String()
	if strings.Contains(combined, enrollment) || strings.Contains(combined, password) {
		t.Fatal("注册命令输出包含注册凭据或口令")
	}
	if !strings.Contains(stderr.String(), node.FileFallbackNotice) {
		t.Fatal("没有说明身份使用文件保存")
	}
	nodeID := stdoutField(t, stdout.String(), "node_id")
	raw, err := os.ReadFile(filepath.Join(dir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), enrollment) {
		t.Fatal("身份文件包含注册凭据")
	}
	var ident node.Identity
	if err := json.Unmarshal(raw, &ident); err != nil {
		t.Fatal(err)
	}
	if ident.NodeID != nodeID || ident.CoordinatorURL != srv.URL || strings.Contains(combined, ident.Credential.Token) {
		t.Fatal("重启前的输出包含连接凭据，或节点 ID 不一致")
	}
	privatefiletest.AssertPrivate(t, filepath.Join(dir, node.IdentityFileName))
	if count(t, pool, `SELECT COUNT(*) FROM node_credentials WHERE id = $1::uuid AND node_id = $2::uuid AND revoked_at IS NULL`, ident.Credential.ID, ident.NodeID) != 1 {
		t.Fatal("数据库没有保存可吊销的 credential_id")
	}

	stdout.Reset()
	stderr.Reset()
	err = run(ctx, registerArgs(srv.URL, dir, ""), &stdout, &stderr, func(key string) string {
		switch key {
		case "BATON_ENROLLMENT_TOKEN":
			return "another-token-value-should-not-be-used-01"
		case "BATON_TLS_CA_FILE":
			return caFile
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("再次启动注册命令失败: %v", err)
	}
	if !strings.Contains(stderr.String(), "未重新注册") {
		t.Fatal("已有身份时仍然发起了注册")
	}
	if stdoutField(t, stdout.String(), "node_id") != nodeID {
		t.Fatal("重启后节点身份发生变化")
	}
	after, err := os.ReadFile(filepath.Join(dir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, after) {
		t.Fatal("重启改写了本地身份")
	}
	if strings.Contains(stdout.String()+stderr.String(), ident.Credential.Token) || strings.Contains(stdout.String()+stderr.String(), enrollment) {
		t.Fatal("重启输出包含凭据")
	}
	if count(t, pool, `SELECT COUNT(*) FROM nodes`) != 1 {
		t.Fatal("重启产生了新节点")
	}
	if strings.Contains(logs.String(), enrollment) || strings.Contains(logs.String(), ident.Credential.Token) || strings.Contains(logs.String(), password) {
		t.Fatal("服务日志包含凭据或口令")
	}
}

func TestRegisterDefaults(t *testing.T) {
	opts, err := parseRegister([]string{"--coordinator", "https://baton.example"})
	if err != nil {
		t.Fatal(err)
	}
	hostname, _ := os.Hostname()
	if opts.displayName != defaultDisplayName(hostname) || opts.system != defaultSystem(runtime.GOOS) {
		t.Fatalf("注册默认值不正确: %+v", opts)
	}
	for goos, want := range map[string]string{"darwin": "macos", "windows": "windows", "linux": "linux"} {
		if got := defaultSystem(goos); got != want {
			t.Fatalf("系统 %s: %s", goos, got)
		}
	}
	for _, tc := range []struct{ raw, want string }{
		{" \tDesk\n\x7f\u0085 ", "Desk"},
		{"\t\n", "Workstation"},
		{strings.Repeat("机", 81), strings.Repeat("机", 80)},
		{strings.Repeat("a", 79) + " b", strings.Repeat("a", 79)},
	} {
		if got := defaultDisplayName(tc.raw); got != tc.want {
			t.Fatalf("主机名清理结果 %q", got)
		}
	}
	opts, err = parseRegister([]string{"--coordinator", "https://baton.example", "--display-name", " My Desk ", "--system", "custom"})
	if err != nil || opts.displayName != " My Desk " || opts.system != "custom" {
		t.Fatal("显式参数被修改")
	}
	if _, err := parseRegister([]string{"--coordinator", "https://baton.example", "--display-name", ""}); err == nil {
		t.Fatal("显式空显示名被接受")
	}
}

func TestUpRegistersReusesIdentityAndRuns(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node")
	workspace := filepath.Join(t.TempDir(), "My Repo")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	workspace, _ = filepath.EvalSymlinks(workspace)
	ident := cliIdentity(t)
	var registrations, connections atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/nodes/register":
			registrations.Add(1)
			var payload struct {
				DisplayName string `json:"display_name"`
				System      string `json:"system"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
				return
			}
			if err := node.Validate(payload.DisplayName, payload.System, "", nil); err != nil {
				t.Error(err)
				return
			}
			_ = json.NewEncoder(w).Encode(ident)
		case "/v1/node":
			connections.Add(1)
			roots, err := node.ListBrowseRoots(dir)
			if err != nil || len(roots) != 1 || roots[0].Path != workspace {
				t.Errorf("连接前没有登记 workspace: %+v %v", roots, err)
			}
			ws, err := websocket.Accept(w, r, nil)
			if err != nil {
				t.Error(err)
				return
			}
			defer ws.CloseNow()
			_, _, err = ws.Read(r.Context())
			if err != nil {
				t.Error(err)
				return
			}
			_ = ws.Write(r.Context(), websocket.MessageText, []byte(`{"kind":"auth_result","ok":false,"code":"invalid_credential"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ca := writeCA(t, srv.Certificate())
	token, err := auth.NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		switch key {
		case "BATON_ENROLLMENT_TOKEN":
			return token
		case "BATON_TLS_CA_FILE":
			return ca
		default:
			return ""
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runCommand := func(args []string, getenv func(string) string) error {
		return runWithOptions(ctx, args, io.Discard, io.Discard, getenv, node.RunOptions{
			ProbeRuntimeAgentVersion: func(context.Context, string) (string, error) { return "", errors.New("未启用版本探测") },
		})
	}
	args := []string{"up", "--coordinator", srv.URL, "--workspace", workspace, "--data-dir", dir}
	if err := runCommand(args, getenv); !errors.Is(err, node.ErrNeedsReauth) {
		t.Fatalf("注册后未进入连接: %v", err)
	}
	before, err := os.ReadFile(filepath.Join(dir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	getenvWithoutEnrollment := func(key string) string {
		if key == "BATON_TLS_CA_FILE" {
			return ca
		}
		return ""
	}
	for i := 0; i < 2; i++ {
		if err := runCommand([]string{"up", "--workspace", workspace, "--data-dir", dir}, getenvWithoutEnrollment); !errors.Is(err, node.ErrNeedsReauth) {
			t.Fatalf("复用身份连接: %v", err)
		}
	}
	after, err := os.ReadFile(filepath.Join(dir, node.IdentityFileName))
	if err != nil || !bytes.Equal(before, after) || registrations.Load() != 1 || connections.Load() != 3 {
		t.Fatal("重启未复用身份或重复注册")
	}
	if err := runCommand([]string{"run", "--data-dir", dir}, getenvWithoutEnrollment); !errors.Is(err, node.ErrNeedsReauth) {
		t.Fatalf("run 未推导 relay: %v", err)
	}
	if err := runCommand([]string{"run", "--data-dir", dir, "--relay", "http://invalid"}, getenvWithoutEnrollment); err == nil || errors.Is(err, node.ErrNeedsReauth) {
		t.Fatal("显式 relay 没有优先使用")
	}
}

func TestUpRequiresEnrollmentAndRejectsDamagedIdentity(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{nil, "--coordinator"},
		{[]string{"--coordinator", "https://baton.example"}, "注册凭据"},
		{[]string{"--workspace", "relative"}, "绝对路径"},
	} {
		args := append([]string{"up", "--data-dir", filepath.Join(t.TempDir(), "node")}, tc.args...)
		err := run(context.Background(), args, io.Discard, io.Discard, func(string) string { return "" })
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("缺少前置条件: %v", err)
		}
	}
	dir := filepath.Join(t.TempDir(), "node")
	if err := node.PrepareDataDir(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, node.IdentityFileName)
	if err := os.WriteFile(path, []byte("invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := run(context.Background(), []string{"up", "--data-dir", dir}, io.Discard, io.Discard, func(string) string { return "" })
	if err == nil || strings.Contains(err.Error(), "--coordinator") {
		t.Fatal("损坏身份被视为未注册")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "invalid" {
		t.Fatal("损坏身份被覆盖")
	}
}

func TestRunRequiresRelayForIdentityWithoutCoordinator(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node")
	if err := node.WriteIdentity(dir, cliIdentity(t)); err != nil {
		t.Fatal(err)
	}
	err := run(context.Background(), []string{"run", "--data-dir", dir}, io.Discard, io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "--relay") {
		t.Fatalf("没有提示 relay: %v", err)
	}
}

func TestEnsureWorkspaceIDsAndIdempotency(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "node")
	for _, name := range []string{"Repo", "repo", "中文", strings.Repeat("x", 100)} {
		workspace := filepath.Join(t.TempDir(), name)
		if err := os.Mkdir(workspace, 0o700); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 2; i++ {
			if err := ensureWorkspace(dir, workspace); err != nil {
				t.Fatal(err)
			}
		}
	}
	roots, err := node.ListBrowseRoots(dir)
	if err != nil || len(roots) != 4 {
		t.Fatalf("目录重复登记: %+v %v", roots, err)
	}
	for _, root := range roots {
		if err := node.CheckBrowseQuery(root.ID, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := ensureWorkspace(dir, "relative"); err == nil {
		t.Fatal("相对 workspace 被接受")
	}
}

func cliIdentity(t *testing.T) node.Identity {
	t.Helper()
	ids := make([]string, 3)
	for i := range ids {
		var err error
		ids[i], err = identity.NewUUID()
		if err != nil {
			t.Fatal(err)
		}
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	token, err := signer.SignNodeToken(ids[0], ids[1], ids[2], expires)
	if err != nil {
		t.Fatal(err)
	}
	return node.Identity{NodeID: ids[0], EmployeeID: ids[1], DisplayName: "Desk", System: node.SystemLinux, RegistrationSeq: 1, RegisteredAt: time.Now().UTC(), Credential: node.Credential{ID: ids[2], Version: 1, Token: token, ExpiresAt: expires}}
}

func registerArgs(coordinator, dir, enrollmentFile string) []string {
	args := []string{
		"register",
		"--coordinator", coordinator,
		"--data-dir", dir,
		"--display-name", "Desk",
		"--system", "linux",
		"--role", "pc",
		"--capability", "start",
	}
	if enrollmentFile != "" {
		args = append(args, "--enrollment-file", enrollmentFile)
	}
	return args
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

func loginCSRF(t *testing.T, client *http.Client, base, username, password string) string {
	t.Helper()
	payload, err := json.Marshal(map[string]string{"username": username, "password": password})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, base+"/api/v1/login", bytes.NewReader(payload))
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
	if resp.StatusCode != http.StatusOK || strings.Contains(string(body), password) {
		t.Fatalf("登录状态 %d", resp.StatusCode)
	}
	var parsed struct {
		CSRFToken string `json:"csrf_token"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.CSRFToken == "" {
		t.Fatal("登录响应缺少 CSRF 令牌")
	}
	return parsed.CSRFToken
}

func fetchEnrollment(t *testing.T, client *http.Client, base, csrf string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+"/api/v1/node-enrollments", bytes.NewReader([]byte(`{}`)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://baton.example")
	req.Header.Set(auth.CSRFHeader, csrf)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("领取注册凭据状态 %d", resp.StatusCode)
	}
	var parsed struct {
		Token string `json:"enrollment_token"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Token == "" {
		t.Fatal("注册凭据响应不完整")
	}
	if strings.Contains(resp.Header.Get("Set-Cookie"), parsed.Token) {
		t.Fatal("注册凭据被写入 Cookie")
	}
	return parsed.Token
}

func writeCA(t *testing.T, cert *x509.Certificate) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.pem")
	var buf bytes.Buffer
	if err := pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func count(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var n int
	if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func stdoutField(t *testing.T, text, key string) string {
	t.Helper()
	prefix := key + "="
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, prefix) {
			value := strings.TrimPrefix(line, prefix)
			if value == "" {
				t.Fatalf("%s 为空", key)
			}
			return value
		}
	}
	t.Fatalf("输出缺少 %s", key)
	return ""
}

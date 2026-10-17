package relay_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/protocol"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProcessRevokeDisconnectsAndSurvivesRelayRestart(t *testing.T) {
	coordBin, relayBin, batondBin := buildBins(t)
	pool := dbtest.Open(t)
	ctx := context.Background()
	schema := currentSchema(t, pool)
	env := revokeProcessEnv(t, schema)
	startCmd(t, relayBin, nil, env.relay)
	time.Sleep(300 * time.Millisecond)
	coordProc := startCmd(t, coordBin, []string{"serve"}, env.coord)
	waitListen(t, env.apiAddr)
	waitListen(t, env.nodeAddr)

	const password = "revoke-process-password"
	alice, err := admin.CreateLocal(ctx, pool, "alice", "Alice", password)
	if err != nil {
		t.Fatal(err)
	}
	client := tlsClient(t, env.roots)
	base := "https://" + env.apiAddr
	csrf := login(t, client, base, "alice", password)
	desk := registerThrough(t, client, base, csrf, "Desk")
	other := registerThrough(t, client, base, csrf, "Other")
	dataDir := filepath.Join(env.dir, "node")
	if err := node.WriteIdentity(dataDir, desk); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dataDir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	batondProc := startCmd(t, batondBin, []string{"run", "--relay", "wss://" + env.nodeAddr + "/v1/node", "--data-dir", dataDir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE":        env.certFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
	}))
	waitNode(t, client, base, desk.NodeID, true, true, true)
	if result := authProcess(t, env.nodeAddr, other.Credential.Token, newProcessID(t), env.roots); !result.OK {
		t.Fatal("其他节点认证失败")
	}

	status, body := postText(t, client, base+"/api/v1/nodes/"+desk.NodeID+"/revoke", csrf, map[string]any{})
	if status != http.StatusOK || !strings.Contains(body, `"status":"effective"`) || !strings.Contains(body, "不会停止") || strings.Contains(body, "已经停止") {
		t.Fatalf("吊销响应不正确: %d %s", status, body)
	}
	if !strings.Contains(body, `"needs_reselection":true`) || !strings.Contains(body, desk.NodeID) || !strings.Contains(body, alice.ID) {
		t.Fatalf("吊销响应没有保留默认 PC 或操作者: %s", body)
	}
	batondProc.waitExit(t, 20*time.Second)
	if !strings.Contains(batondProc.out.String(), "需要重新认证") {
		t.Fatalf("节点没有因凭据失效退出: %s", batondProc.out.String())
	}
	after, err := os.ReadFile(filepath.Join(dataDir, node.IdentityFileName))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("吊销后节点身份文件被改写")
	}
	if result := authProcess(t, env.nodeAddr, desk.Credential.Token, newProcessID(t), env.roots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("已生效凭据仍能连接: %+v", result)
	}
	if countQuery(t, pool, `SELECT COUNT(*) FROM nodes WHERE employee_id = $1::uuid`, alice.ID) != 2 {
		t.Fatal("吊销删除了节点")
	}
	if countQuery(t, pool, `SELECT COUNT(*) FROM node_credentials WHERE id = $1::uuid`, desk.Credential.ID) != 1 {
		t.Fatal("吊销删除了凭据")
	}
	if countQuery(t, pool, `SELECT COUNT(*) FROM node_revocations WHERE node_id = $1::uuid AND actor_employee_id = $2::uuid AND applied_at IS NOT NULL`, desk.NodeID, alice.ID) != 1 {
		t.Fatal("没有记下操作者、时间和已生效回执")
	}
	if defaultQuery(t, pool, alice.ID) != desk.NodeID {
		t.Fatal("吊销改写了默认 PC")
	}

	relayProc := latestProc(t, relayBin)
	relayProc.stop()
	relayProc = startCmd(t, relayBin, nil, env.relay)
	waitListen(t, env.nodeAddr)
	if result := authProcess(t, env.nodeAddr, desk.Credential.Token, newProcessID(t), env.roots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("Relay 重启后放行了同一凭据: %+v", result)
	}
	if result := authProcess(t, env.nodeAddr, other.Credential.Token, newProcessID(t), env.roots); !result.OK {
		t.Fatalf("Relay 重启后其他节点不能连接: %+v", result)
	}
	third := registerThrough(t, client, base, csrf, "Third")
	if defaultQuery(t, pool, alice.ID) != desk.NodeID || third.NodeID == desk.NodeID {
		t.Fatal("新节点被自动选成了默认 PC")
	}
	waitRevocationHTTP(t, client, base, desk.NodeID, "effective")
	logs := coordProc.out.String() + relayProc.out.String() + batondProc.out.String()
	if strings.Contains(logs, desk.Credential.Token) || strings.Contains(logs, other.Credential.Token) || strings.Contains(logs, env.controlToken) {
		t.Fatal("运行日志包含凭据")
	}
}

func TestProcessRevokeStaysPendingWhileRelayIsDown(t *testing.T) {
	coordBin, relayBin, batondBin := buildBins(t)
	pool := dbtest.Open(t)
	ctx := context.Background()
	schema := currentSchema(t, pool)
	env := revokeProcessEnv(t, schema)
	startCmd(t, coordBin, []string{"serve"}, env.coord)
	waitListen(t, env.apiAddr)

	const password = "revoke-down-password-01"
	alice, err := admin.CreateLocal(ctx, pool, "alice", "Alice", password)
	if err != nil {
		t.Fatal(err)
	}
	client := tlsClient(t, env.roots)
	base := "https://" + env.apiAddr
	csrf := login(t, client, base, "alice", password)
	desk := registerThrough(t, client, base, csrf, "Desk")
	dataDir := filepath.Join(env.dir, "offline-node")
	if err := node.WriteIdentity(dataDir, desk); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dataDir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}

	status, body := postText(t, client, base+"/api/v1/nodes/"+desk.NodeID+"/revoke", csrf, map[string]any{})
	if status != http.StatusOK || !strings.Contains(body, `"status":"pending"`) || strings.Contains(body, `"status":"effective"`) || strings.Contains(body, "已生效") || strings.Contains(body, "已经停止") {
		t.Fatalf("Relay 不可达时声称吊销已生效: %d %s", status, body)
	}
	if !strings.Contains(body, "尚未生效") || !strings.Contains(body, "不会停止") || !strings.Contains(body, "需要重新选择") {
		t.Fatalf("处理中的说明不完整: %s", body)
	}
	if countQuery(t, pool, `SELECT COUNT(*) FROM node_revocations WHERE node_id = $1::uuid AND applied_at IS NULL AND actor_employee_id = $2::uuid`, desk.NodeID, alice.ID) != 1 {
		t.Fatal("不可达时没有保存未确认的吊销")
	}
	if defaultQuery(t, pool, alice.ID) != desk.NodeID {
		t.Fatal("不可达时改写了默认 PC")
	}

	startCmd(t, relayBin, nil, env.relay)
	waitListen(t, env.nodeAddr)
	waitRevocationHTTP(t, client, base, desk.NodeID, "effective")
	batondProc := startCmd(t, batondBin, []string{"run", "--relay", "wss://" + env.nodeAddr + "/v1/node", "--data-dir", dataDir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE":        env.certFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
	}))
	batondProc.waitExit(t, 20*time.Second)
	after, err := os.ReadFile(filepath.Join(dataDir, node.IdentityFileName))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("认证失败后节点重新注册或改写了身份")
	}
	if !strings.Contains(batondProc.out.String(), "需要重新认证") {
		t.Fatalf("节点没有说明需要重新认证: %s", batondProc.out.String())
	}
	latestProc(t, relayBin).stop()
	startCmd(t, relayBin, nil, env.relay)
	waitListen(t, env.nodeAddr)
	if result := authProcess(t, env.nodeAddr, desk.Credential.Token, newProcessID(t), env.roots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("Relay 重启后放行了同一凭据: %+v", result)
	}
	other := registerThrough(t, client, base, csrf, "Other")
	if defaultQuery(t, pool, alice.ID) != desk.NodeID {
		t.Fatal("Relay 恢复后自动改选了默认 PC")
	}
	if result := authProcess(t, env.nodeAddr, other.Credential.Token, newProcessID(t), env.roots); !result.OK {
		t.Fatalf("未吊销节点不能连接: %+v", result)
	}
	if strings.Contains(batondProc.out.String(), desk.Credential.Token) {
		t.Fatal("节点日志包含连接凭据")
	}
}

type revokeEnv struct {
	dir          string
	certFile     string
	apiAddr      string
	nodeAddr     string
	controlToken string
	roots        *x509.CertPool
	coord        []string
	relay        []string
}

func revokeProcessEnv(t *testing.T, schema string) revokeEnv {
	t.Helper()
	dir := t.TempDir()
	certFile, keyFile, cert := writeServerCert(t, dir)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	signingPEM, err := signer.MarshalPKCS8PEM()
	if err != nil {
		t.Fatal(err)
	}
	signingFile := filepath.Join(dir, "signing.pem")
	if err := os.WriteFile(signingFile, signingPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	apiAddr := freeAddr(t)
	controlAddr := freeAddr(t)
	nodeAddr := freeAddr(t)
	const controlToken = "revoke-process-token-01"
	dbURL := strings.TrimSpace(os.Getenv("BATON_TEST_DATABASE_URL"))
	return revokeEnv{
		dir: dir, certFile: certFile, apiAddr: apiAddr, nodeAddr: nodeAddr, controlToken: controlToken, roots: roots,
		coord: childEnv(map[string]string{
			"BATON_DATABASE_URL":       dbURL,
			"BATON_DB_SCHEMA":          schema,
			"BATON_HTTP_ADDR":          apiAddr,
			"BATON_CONTROL_ADDR":       controlAddr,
			"BATON_CONTROL_TOKEN":      controlToken,
			"BATON_NODE_SIGNING_KEY":   signingFile,
			"BATON_ALLOWED_ORIGINS":    "https://baton.example",
			"BATON_TLS_CERT_FILE":      certFile,
			"BATON_TLS_KEY_FILE":       keyFile,
			"BATON_HEARTBEAT_INTERVAL": "200ms",
			"BATON_OFFLINE_AFTER":      "8s",
		}),
		relay: childEnv(map[string]string{
			"BATON_LISTEN_ADDR":     nodeAddr,
			"BATON_COORDINATOR_URL": "https://" + controlAddr,
			"BATON_CONTROL_TOKEN":   controlToken,
			"BATON_TLS_CERT_FILE":   certFile,
			"BATON_TLS_KEY_FILE":    keyFile,
			"BATON_TLS_CA_FILE":     certFile,
		}),
	}
}

func currentSchema(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var schema string
	if err := pool.QueryRow(context.Background(), "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	return schema
}

func (p *running) waitExit(t *testing.T, timeout time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		p.once.Do(func() { _ = p.cmd.Wait() })
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatal("进程没有退出")
	}
}

func postText(t *testing.T, client *http.Client, rawURL, csrf string, payload any) (int, string) {
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
	req.Header.Set("Origin", "https://baton.example")
	if csrf != "" {
		req.Header.Set(auth.CSRFHeader, csrf)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(raw)
}

func waitRevocationHTTP(t *testing.T, client *http.Client, base, id, status string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		var view struct {
			Status     string `json:"revocation_status"`
			Executable bool   `json:"executable"`
			Revocation *struct {
				Notice string `json:"local_process_notice"`
			} `json:"revocation"`
		}
		if err := getJSON(t, client, base+"/api/v1/nodes/"+id, &view); err == nil {
			last = view.Status
			if view.Status == status && !view.Executable && view.Revocation != nil && strings.Contains(view.Revocation.Notice, "不会停止") && !strings.Contains(view.Revocation.Notice, "已经停止") {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("节点查询没有变成 %s，最后是 %s", status, last)
}

func countQuery(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func defaultQuery(t *testing.T, pool *pgxpool.Pool, employeeID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(default_pc_node_id::text, '')
		FROM employee_settings WHERE employee_id = $1::uuid`, employeeID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

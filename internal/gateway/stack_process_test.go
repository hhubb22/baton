package gateway_test

import (
	"context"
	"crypto/x509"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/session"

	"github.com/jackc/pgx/v5/pgxpool"
)

type processStack struct {
	pool        *pgxpool.Pool
	client      *http.Client
	base        string
	csrf        string
	ident       node.Identity
	employeeID  string
	dataDir     string
	certFile    string
	nodeAddr    string
	apiAddr     string
	batondBin   string
	coordBin    string
	signingFile string
	coordEnv    []string
	batondArgs  []string
	batondEnv   []string
	coord       *running
	batond      *running
	roots       *x509.CertPool
}

func startThreadStack(t *testing.T, extra map[string]string) *processStack {
	t.Helper()
	coordBin, batondBin := buildBins(t)
	return startThreadStackWithBins(t, extra, coordBin, batondBin)
}

func startThreadStackWithBins(t *testing.T, extra map[string]string, coordBin, batondBin string, dataRoot ...string) *processStack {
	t.Helper()
	if extra["BATON_PI_BIN"] != "" || extra["BATON_CODEX_BINARY"] != "" || extra["BATON_KIRO_BINARY"] != "" {
		batondBin = buildReplayBatond(t)
	}
	pool := dbtest.Open(t)
	ctx := context.Background()
	var schema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	var dir string
	if len(dataRoot) != 0 && dataRoot[0] != "" {
		dir = dataRoot[0]
	} else {
		dir = t.TempDir()
	}
	certFile, keyFile, cert := writeServerCert(t, dir)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	signingFile := filepath.Join(dir, "signing.pem")
	if err := signer.WriteFile(signingFile); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	apiAddr := "127.0.0.1:0"
	// 浏览器实时通道要求预先配置同源地址，端口保留到 Coordinator 启动。
	if extra["BATON_HTTP_ADDR"] != "" {
		apiAddr = extra["BATON_HTTP_ADDR"]
	}
	var nodeAddr string
	dbURL := dbtest.URL()
	coordValues := map[string]string{
		"BATON_DATABASE_URL":       dbURL,
		"BATON_DB_SCHEMA":          schema,
		"BATON_HTTP_ADDR":          apiAddr,
		"BATON_NODE_SIGNING_KEY":   signingFile,
		"BATON_ALLOWED_ORIGINS":    "https://baton.example,https://" + apiAddr,
		"BATON_TLS_CERT_FILE":      certFile,
		"BATON_TLS_KEY_FILE":       keyFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
		"BATON_OFFLINE_AFTER":      "8s",
	}
	coordEnv := childEnv(coordValues)
	coord := startCmd(t, coordBin, []string{"serve"}, coordEnv)
	apiAddr = coord.listenAddr(t)
	nodeAddr = apiAddr
	setChildEnv(coordEnv, "BATON_HTTP_ADDR", apiAddr)
	const password = "thread-test-password-1"
	emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice", password)
	if err != nil {
		t.Fatal(err)
	}
	client := tlsClient(t, roots)
	base := "https://" + apiAddr
	csrf := login(t, client, base, "alice", password)
	ident := registerAgent(t, client, base, csrf, "Desk", []string{"pi", "codex"})
	if _, err := pool.Exec(ctx, `UPDATE nodes SET default_agent_type = 'pi' WHERE id = $1::uuid`, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(dir, "node")
	if err := node.WriteIdentity(dataDir, ident); err != nil {
		t.Fatal(err)
	}
	// 进程场景显式配置授权目录，避免扫描运行测试的用户主目录。
	if err := os.WriteFile(filepath.Join(dataDir, "browse-roots.json"), []byte(`{"roots":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		"BATON_TLS_CA_FILE":        certFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
	}
	for key, value := range extra {
		env[key] = value
	}
	batondArgs := []string{"run", "--relay", "wss://" + nodeAddr + "/v1/node", "--data-dir", dataDir}
	batondEnv := childEnv(env)
	batond := startCmd(t, batondBin, batondArgs, batondEnv)
	waitNode(t, client, base, ident.NodeID, true, true, true)
	return &processStack{
		pool: pool, client: client, base: base, csrf: csrf, ident: ident, employeeID: emp.ID,
		dataDir: dataDir, certFile: certFile, nodeAddr: nodeAddr, apiAddr: apiAddr,
		batondBin: batondBin, coordBin: coordBin, signingFile: signingFile,
		coordEnv: coordEnv, batondArgs: batondArgs, batondEnv: batondEnv,
		coord: coord, batond: batond, roots: roots,
	}
}

func registerAgent(t *testing.T, client *http.Client, base, csrf, name string, caps []string) node.Identity {
	t.Helper()
	var enrollment struct {
		Token string `json:"enrollment_token"`
	}
	code := postJSON(t, client, base+"/api/v1/node-enrollments", map[string]any{}, csrf, &enrollment)
	if code != http.StatusOK || enrollment.Token == "" {
		t.Fatalf("领取注册凭据状态 %d", code)
	}
	var ident node.Identity
	code = postJSON(t, client, base+"/api/v1/nodes/register", map[string]any{
		"enrollment_token": enrollment.Token,
		"display_name":     name,
		"system":           "linux",
		"role":             "pc",
		"capabilities":     caps,
	}, "", &ident)
	if code != http.StatusOK || ident.NodeID == "" {
		t.Fatalf("注册状态 %d", code)
	}
	return ident
}

func waitLog(t *testing.T, proc *running, text string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(proc.out.String(), text) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("日志里没有 %s: %s", text, proc.out.String())
}

func workerStatus(t *testing.T, dataDir, sessionID string) session.Status {
	t.Helper()
	client := dialWorker(t, dataDir, sessionID)
	defer client.Close()
	st, err := client.Status()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func dialWorker(t *testing.T, dataDir, sessionID string) *session.Client {
	t.Helper()
	tokenPath, err := session.TokenPath(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := session.Endpoint(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := session.Dial(ctx, endpoint, strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func restartBatond(t *testing.T, st *processStack) {
	t.Helper()
	st.batond.stop()
	st.batond = startCmd(t, st.batondBin, st.batondArgs, st.batondEnv)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
}

func restartRelay(t *testing.T, st *processStack) {
	t.Helper()
	st.coord.stop()
	time.Sleep(300 * time.Millisecond)
	st.coord = startCmd(t, st.coordBin, []string{"serve"}, st.coordEnv)
	waitListen(t, st.nodeAddr)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
}

func restartCoord(t *testing.T, st *processStack) {
	t.Helper()
	st.coord.stop()
	st.coord = startCmd(t, st.coordBin, []string{"serve"}, st.coordEnv)
	waitListen(t, st.apiAddr)
}

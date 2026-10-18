package relay_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/session"
	"baton/internal/task"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "modernc.org/sqlite"
)

type prepareStack struct {
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
	relayBin    string
	coordBin    string
	signingFile string
	relayEnv    []string
	coordEnv    []string
	batondArgs  []string
	batondEnv   []string
	relay       *running
	coord       *running
	batond      *running
	roots       *x509.CertPool
}

func TestPrepareReconnectsWorkerAndRejectsBusySession(t *testing.T) {
	st := startPrepareStack(t, map[string]string{
		"BATON_TEST_DROP_PREPARE_ACKS": "1",
		"BATON_TEST_SLOW_WRITE":        "1",
	})
	var workerPID atomic.Int64
	t.Cleanup(func() { stopWorker(int(workerPID.Load())) })

	var created task.Record
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{
		"request_id": "prep-1", "description": "准备天线",
	}, st.csrf, &created); code != http.StatusOK || created.TaskID == "" || created.Status != task.StatusQueued {
		t.Fatalf("接受任务状态 %d %+v", code, created)
	}
	sessionID, executionID, messageID := waitPrepared(t, st, created.TaskID)
	if countSent(st.coord.out.String(), messageID) < 2 {
		t.Fatalf("稳定消息没有重发: %s", st.coord.out.String())
	}
	if !strings.Contains(st.batond.out.String(), "event=prepare_not_acked") || !strings.Contains(st.batond.out.String(), "event=prepare_acked") {
		t.Fatalf("节点没有先保留映射再确认: %s", st.batond.out.String())
	}
	gotExec, gotSession := oneReceipt(t, st.dataDir)
	if gotExec != executionID || gotSession != sessionID {
		t.Fatalf("本地映射是 %s %s，中心是 %s %s", gotExec, gotSession, executionID, sessionID)
	}
	if _, err := os.Stat(filepath.Join(st.dataDir, "executor.log")); !os.IsNotExist(err) {
		t.Fatal("准备阶段写出了执行器日志")
	}
	view := getSession(t, st, sessionID)
	if view.Status != "idle" || !view.Busy || view.BoundExecutionID == nil || *view.BoundExecutionID != executionID || len(view.TaskIDs) != 1 || view.TaskIDs[0] != created.TaskID {
		t.Fatalf("Session 关系不正确: %+v", view)
	}
	first := workerStatus(t, st.dataDir, sessionID)
	if first.ExecutorStarts != 0 || first.HookRuns != 0 || first.PID <= 0 {
		t.Fatalf("准备启动了执行器: %+v", first)
	}
	workerPID.Store(int64(first.PID))
	if elapsed, seqs := appendSlow(t, st.dataDir, sessionID); elapsed < 350*time.Millisecond || len(seqs) != 2 {
		t.Fatalf("并发写入没有互斥: %s %v", elapsed, seqs)
	}
	workerCtx, workerCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer workerCancel()
	workerCmd := exec.CommandContext(workerCtx, st.batondBin, "worker", "--data-dir", st.dataDir, "--session", sessionID)
	workerCmd.Env = childEnv(nil)
	out, err := workerCmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "已有 Worker 接管该 Session") {
		t.Fatalf("第二个 Worker 没有被拒绝: %v %s", err, out)
	}

	st.batond.stop()
	if err := processAlive(first.PID); err != nil {
		t.Fatalf("batond 退出时 Worker 也退出了: %v", err)
	}
	st.batond = startCmd(t, st.batondBin, []string{"run", "--relay", "wss://" + st.nodeAddr + "/v1/node", "--data-dir", st.dataDir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE":        st.certFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
	}))
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	waitLog(t, st.batond, "event=worker_reconnected")
	again := workerStatus(t, st.dataDir, sessionID)
	if again.PID != first.PID || again.Attaches < first.Attaches+1 || again.ExecutorStarts != 0 {
		t.Fatalf("没有连回原 Worker: before %+v after %+v log %s", first, again, st.batond.out.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, st.batondBin, "run", "--relay", "wss://"+st.nodeAddr+"/v1/node", "--data-dir", st.dataDir)
	cmd.Env = childEnv(map[string]string{"BATON_TLS_CA_FILE": st.certFile, "BATON_HEARTBEAT_INTERVAL": "200ms"})
	locked, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(locked), "已有 batond 使用该数据目录") {
		t.Fatalf("第二个 batond 没有被拒绝: %v %s", err, locked)
	}

	code, raw := postRaw(t, st.client, st.base+"/api/v1/tasks", map[string]any{
		"request_id": "busy-1", "description": "占用中", "target_session_id": sessionID, "agent_type": "pi",
	}, st.csrf)
	if code != http.StatusConflict || !strings.Contains(string(raw), `"code":"session_busy"`) {
		t.Fatalf("忙碌 Session 得到 %d %s", code, raw)
	}
	mismatchID := newProcessID(t)
	if _, err := st.pool.Exec(context.Background(), `
		INSERT INTO sessions (id, employee_id, node_id, agent_type, status, created_at, updated_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'pi', 'idle', now(), now())`,
		mismatchID, st.employeeID, st.ident.NodeID); err != nil {
		t.Fatal(err)
	}
	code, raw = postRaw(t, st.client, st.base+"/api/v1/tasks", map[string]any{
		"request_id": "mismatch-1", "description": "类型不符", "target_session_id": mismatchID, "agent_type": "codex",
	}, st.csrf)
	if code != http.StatusBadRequest || !strings.Contains(string(raw), `"code":"unsupported"`) {
		t.Fatalf("不匹配 Session 得到 %d %s", code, raw)
	}
	var tasks int
	if err := st.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM tasks`).Scan(&tasks); err != nil || tasks != 1 {
		t.Fatalf("拒绝请求写入了任务: %v %d", err, tasks)
	}
}

func TestPrepareDoesNotAckWhenPersistFails(t *testing.T) {
	st := startPrepareStack(t, map[string]string{"BATON_TEST_FAIL_PERSIST": "1"})
	var created task.Record
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{
		"request_id": "fail-1", "description": "不能落盘",
	}, st.csrf, &created); code != http.StatusOK {
		t.Fatalf("接受任务状态 %d", code)
	}
	waitLog(t, st.batond, "event=prepare_not_acked")
	if strings.Contains(st.batond.out.String(), "event=prepare_acked") || strings.Contains(st.batond.out.String(), "event=worker_started") {
		t.Fatalf("持久化失败后仍继续: %s", st.batond.out.String())
	}
	if n, _, _ := receiptCount(t, filepath.Join(st.dataDir, "node.db")); n != 0 {
		t.Fatalf("持久化失败仍有 %d 条映射", n)
	}
	if _, err := os.Stat(filepath.Join(st.dataDir, "sessions")); !os.IsNotExist(err) {
		t.Fatal("持久化失败后创建了 Session 目录")
	}
	var queued, unprepared, unacked bool
	if err := st.pool.QueryRow(context.Background(), `
		SELECT t.status = 'queued', e.prepared_at IS NULL, o.acked_at IS NULL
		FROM tasks t
		JOIN executions e ON e.task_id = t.id
		JOIN dispatch_outbox o ON o.task_id = t.id
		WHERE t.id = $1::uuid`, created.TaskID).Scan(&queued, &unprepared, &unacked); err != nil || !queued || !unprepared || !unacked {
		t.Fatalf("失败的准备被确认了: %v queued %v unprepared %v unacked %v", err, queued, unprepared, unacked)
	}
}

func startPrepareStack(t *testing.T, extra map[string]string) *prepareStack {
	t.Helper()
	coordBin, relayBin, batondBin := buildBins(t)
	pool := dbtest.Open(t)
	ctx := context.Background()
	var schema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
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
	apiAddr := freeAddr(t)
	controlAddr := freeAddr(t)
	nodeAddr := freeAddr(t)
	dbURL := strings.TrimSpace(os.Getenv("BATON_TEST_DATABASE_URL"))
	coordValues := map[string]string{
		"BATON_DATABASE_URL":       dbURL,
		"BATON_DB_SCHEMA":          schema,
		"BATON_HTTP_ADDR":          apiAddr,
		"BATON_CONTROL_ADDR":       controlAddr,
		"BATON_CONTROL_TOKEN":      "prepare-control-token-01",
		"BATON_NODE_SIGNING_KEY":   signingFile,
		"BATON_ALLOWED_ORIGINS":    "https://baton.example",
		"BATON_TLS_CERT_FILE":      certFile,
		"BATON_TLS_KEY_FILE":       keyFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
		"BATON_OFFLINE_AFTER":      "8s",
	}
	for key, value := range extra {
		if strings.HasPrefix(key, "BATON_TEST_") {
			coordValues[key] = value
		}
	}
	coordEnv := childEnv(coordValues)
	relayEnv := childEnv(map[string]string{
		"BATON_LISTEN_ADDR":     nodeAddr,
		"BATON_COORDINATOR_URL": "https://" + controlAddr,
		"BATON_CONTROL_TOKEN":   "prepare-control-token-01",
		"BATON_TLS_CERT_FILE":   certFile,
		"BATON_TLS_KEY_FILE":    keyFile,
		"BATON_TLS_CA_FILE":     certFile,
	})
	relay := startCmd(t, relayBin, nil, relayEnv)
	time.Sleep(400 * time.Millisecond)
	coord := startCmd(t, coordBin, []string{"serve"}, coordEnv)
	waitListen(t, apiAddr)
	waitListen(t, nodeAddr)
	const password = "prepare-test-password-1"
	emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice", password)
	if err != nil {
		t.Fatal(err)
	}
	client := tlsClient(t, roots)
	base := "https://" + apiAddr
	csrf := login(t, client, base, "alice", password)
	ident := registerAgent(t, client, base, csrf, "Desk", []string{"pi", "codex", "start"})
	if _, err := pool.Exec(ctx, `UPDATE nodes SET default_agent_type = 'pi' WHERE id = $1::uuid`, ident.NodeID); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(dir, "node")
	if err := node.WriteIdentity(dataDir, ident); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		"BATON_TLS_CA_FILE":        certFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
		"BATON_TEST_EXECUTOR_LOG":  filepath.Join(dataDir, "executor.log"),
		"BATON_TEST_HOLD_START":    "1",
	}
	for key, value := range extra {
		env[key] = value
	}
	batondArgs := []string{"run", "--relay", "wss://" + nodeAddr + "/v1/node", "--data-dir", dataDir}
	batondEnv := childEnv(env)
	batond := startCmd(t, batondBin, batondArgs, batondEnv)
	waitNode(t, client, base, ident.NodeID, true, true, true)
	return &prepareStack{
		pool: pool, client: client, base: base, csrf: csrf, ident: ident, employeeID: emp.ID,
		dataDir: dataDir, certFile: certFile, nodeAddr: nodeAddr, apiAddr: apiAddr,
		batondBin: batondBin, relayBin: relayBin, coordBin: coordBin, signingFile: signingFile,
		relayEnv: relayEnv, coordEnv: coordEnv, batondArgs: batondArgs, batondEnv: batondEnv,
		relay: relay, coord: coord, batond: batond, roots: roots,
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

func waitPrepared(t *testing.T, st *prepareStack, taskID string) (string, string, string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var sessionID, executionID, messageID, status string
	var version int
	var prepared bool
	for time.Now().Before(deadline) {
		err := st.pool.QueryRow(context.Background(), `
			SELECT t.status, t.version, COALESCE(t.target_session_id::text, ''),
			       e.id::text, e.prepared_at IS NOT NULL, o.id::text
			FROM tasks t
			JOIN executions e ON e.task_id = t.id
			JOIN dispatch_outbox o ON o.task_id = t.id
			WHERE t.id = $1::uuid`, taskID).Scan(&status, &version, &sessionID, &executionID, &prepared, &messageID)
		if err == nil && prepared && status == task.StatusQueued && version >= 2 && sessionID != "" && countSent(st.coord.out.String(), messageID) >= 2 {
			return sessionID, executionID, messageID
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("准备没有完成: status %s version %d session %s prepared %v coord %s node %s", status, version, sessionID, prepared, st.coord.out.String(), st.batond.out.String())
	return "", "", ""
}

func countSent(log, messageID string) int {
	n := 0
	for _, line := range strings.Split(log, "\n") {
		if strings.Contains(line, "event=prepare_sent") && strings.Contains(line, messageID) {
			n++
		}
	}
	return n
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

func oneReceipt(t *testing.T, dataDir string) (string, string) {
	t.Helper()
	n, execID, sessionID := receiptCount(t, filepath.Join(dataDir, "node.db"))
	if n != 1 {
		t.Fatalf("本地执行映射有 %d 条", n)
	}
	return execID, sessionID
}

func receiptCount(t *testing.T, path string) (int, string, string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	var execID, sessionID sql.NullString
	if err := db.QueryRow(`SELECT COUNT(*), MIN(execution_id), MIN(session_id) FROM receipts`).Scan(&n, &execID, &sessionID); err != nil {
		t.Fatal(err)
	}
	return n, execID.String, sessionID.String
}

func getSession(t *testing.T, st *prepareStack, id string) struct {
	Status           string   `json:"status"`
	Busy             bool     `json:"busy"`
	BoundExecutionID *string  `json:"bound_execution_id"`
	TaskIDs          []string `json:"task_ids"`
} {
	t.Helper()
	var view struct {
		Status           string   `json:"status"`
		Busy             bool     `json:"busy"`
		BoundExecutionID *string  `json:"bound_execution_id"`
		TaskIDs          []string `json:"task_ids"`
	}
	if err := getJSON(t, st.client, st.base+"/api/v1/sessions/"+id, &view); err != nil {
		t.Fatal(err)
	}
	return view
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

func appendSlow(t *testing.T, dataDir, sessionID string) (time.Duration, map[int64]bool) {
	t.Helper()
	left := dialWorker(t, dataDir, sessionID)
	defer left.Close()
	right := dialWorker(t, dataDir, sessionID)
	defer right.Close()
	var wg sync.WaitGroup
	seqs := make([]int64, 2)
	errs := make([]error, 2)
	clients := []*session.Client{left, right}
	started := time.Now()
	wg.Add(2)
	for i := range clients {
		go func(i int) {
			defer wg.Done()
			seqs[i], _, errs[i] = clients[i].Append("slow")
		}(i)
	}
	wg.Wait()
	seen := map[int64]bool{}
	for i, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
		seen[seqs[i]] = true
	}
	return time.Since(started), seen
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

func postRaw(t *testing.T, client *http.Client, rawURL string, payload any, csrf string) (int, []byte) {
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
	return resp.StatusCode, raw
}

func stopWorker(pid int) {
	if pid <= 0 {
		return
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	defer process.Release()
	_ = process.Kill()
}

func restartBatond(t *testing.T, st *prepareStack) {
	t.Helper()
	st.batond.stop()
	st.batond = startCmd(t, st.batondBin, st.batondArgs, dropEnv(st.batondEnv, "BATON_TEST_CRASH_AFTER", "BATON_TEST_CRASH_FILE"))
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
}

func restartRelay(t *testing.T, st *prepareStack) {
	t.Helper()
	st.relay.stop()
	time.Sleep(300 * time.Millisecond)
	st.relay = startCmd(t, st.relayBin, nil, st.relayEnv)
	waitListen(t, st.nodeAddr)
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
}

func restartCoord(t *testing.T, st *prepareStack) {
	t.Helper()
	st.coord.stop()
	st.coord = startCmd(t, st.coordBin, []string{"serve"}, st.coordEnv)
	waitListen(t, st.apiAddr)
}

func dropEnv(env []string, keys ...string) []string {
	skip := map[string]bool{}
	for _, key := range keys {
		skip[key] = true
	}
	out := make([]string, 0, len(env))
	for _, item := range env {
		name, _, _ := strings.Cut(item, "=")
		if skip[name] {
			continue
		}
		out = append(out, item)
	}
	return out
}

package gateway_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/session"

	"github.com/coder/websocket"
	"github.com/gofrs/flock"
)

func TestMain(m *testing.M) {
	code := m.Run()
	if buildDir != "" {
		_ = os.RemoveAll(buildDir)
	}
	if fixtureDir != "" {
		_ = os.RemoveAll(fixtureDir)
	}
	os.Exit(code)
}

func TestProcessReconnectsAfterDisconnectAndRestart(t *testing.T) {
	t.Parallel()
	coordBin, batondBin := buildBins(t)
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
	apiAddr := "127.0.0.1:0"
	var nodeAddr string
	dbURL := dbtest.URL()
	coordEnv := childEnv(map[string]string{
		"BATON_DATABASE_URL":       dbURL,
		"BATON_DB_SCHEMA":          schema,
		"BATON_HTTP_ADDR":          apiAddr,
		"BATON_NODE_SIGNING_KEY":   signingFile,
		"BATON_ALLOWED_ORIGINS":    "https://baton.example",
		"BATON_TLS_CERT_FILE":      certFile,
		"BATON_TLS_KEY_FILE":       keyFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
		"BATON_OFFLINE_AFTER":      "8s",
	})
	coordProc := startCmd(t, coordBin, []string{"serve"}, coordEnv)
	apiAddr = coordProc.listenAddr(t)
	nodeAddr = apiAddr
	setChildEnv(coordEnv, "BATON_HTTP_ADDR", apiAddr)

	const password = "process-test-password-1"
	if _, err := admin.CreateLocal(ctx, pool, "alice", "Alice", password); err != nil {
		t.Fatal(err)
	}
	client := tlsClient(t, roots)
	base := "https://" + apiAddr
	csrf := login(t, client, base, "alice", password)
	desk := registerThrough(t, client, base, csrf, "Desk")
	other := registerThrough(t, client, base, csrf, "Other")
	dataDir := filepath.Join(dir, "node")
	if err := node.WriteIdentity(dataDir, desk); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dataDir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}

	if result := authProcess(t, nodeAddr, "not-a-node-credential", newProcessID(t), roots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("非法凭据被接受: %+v", result)
	}
	deskWS := authProcess(t, nodeAddr, desk.Credential.Token, newProcessID(t), roots)
	if !deskWS.OK {
		t.Fatalf("节点认证失败: %+v", deskWS)
	}
	pre := waitNode(t, client, base, desk.NodeID, true, false, false)
	if pre.StatusUpdated.IsZero() || pre.LastContact.IsZero() {
		t.Fatal("在线节点缺少时间")
	}
	otherWS := authProcess(t, nodeAddr, other.Credential.Token, newProcessID(t), roots)
	if !otherWS.OK {
		t.Fatal("第二个节点认证失败")
	}
	forwarded := listenDelivered(otherWS.ws)
	sendProcessEnvelope(t, deskWS.ws, map[string]any{
		"version": protocol.Version, "message_id": newProcessID(t),
		"route":  map[string]string{"to": protocol.ToControl},
		"source": map[string]string{"kind": "node"},
		"body":   map[string]string{"type": "node.sync"},
	})
	if got := readProcess(t, deskWS.ws); got.Code != protocol.CodeForgedSource {
		t.Fatalf("伪造来源得到 %s", got.Code)
	}
	if forwarded() {
		t.Fatal("伪造来源被转发给了其他节点")
	}
	sendProcessEnvelope(t, deskWS.ws, map[string]any{
		"version": protocol.Version, "message_id": newProcessID(t),
		"route": map[string]string{"to": other.NodeID},
		"body":  map[string]string{"type": "ping"},
	})
	if got := readProcess(t, deskWS.ws); got.Code != protocol.CodeRouteForbidden {
		t.Fatalf("节点直投得到 %s", got.Code)
	}
	if forwarded() {
		t.Fatal("节点绕过 Coordinator 把消息投递给了其他节点")
	}
	deskWS.ws.Close(websocket.StatusNormalClosure, "")
	otherWS.ws.Close(websocket.StatusNormalClosure, "")

	proxy := newProxy(t, nodeAddr)
	startCmd(t, batondBin, []string{"run", "--relay", "wss://" + proxy.addr() + "/v1/node", "--data-dir", dataDir}, childEnv(map[string]string{
		"BATON_TLS_CA_FILE":        certFile,
		"BATON_HEARTBEAT_INTERVAL": "200ms",
	}))
	waitNode(t, client, base, desk.NodeID, true, true, true)
	if result := authProcess(t, nodeAddr, desk.Credential.Token, newProcessID(t), roots); result.Code != protocol.CodeIncarnationConflict {
		t.Fatalf("第二个进程接管了节点: %+v", result)
	}
	if !waitNode(t, client, base, desk.NodeID, true, true, true).Executable {
		t.Fatal("incarnation 冲突后原节点不再可执行")
	}

	connected := strings.Count(coordProc.out.String(), "event=node_connected")
	proxy.drop()
	waitCount(t, coordProc, "event=node_connected", connected+1)
	again := waitNode(t, client, base, desk.NodeID, true, true, true)
	if again.ID != desk.NodeID {
		t.Fatal("断线重连后节点身份变了")
	}

	oldCoord := coordProc
	oldUpdated := again.StatusUpdated
	coordProc.stop()
	coordProc = startCmd(t, coordBin, []string{"serve"}, coordEnv)
	waitListen(t, apiAddr)
	restored := waitNode(t, client, base, desk.NodeID, true, true, true)
	if !restored.StatusUpdated.After(oldUpdated) {
		t.Fatal("Coordinator 重启后没有重新认证与同步")
	}

	after, err := os.ReadFile(filepath.Join(dataDir, node.IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) || restored.ID != desk.NodeID {
		t.Fatal("Coordinator 重启后节点身份没有保留")
	}
	var listed struct {
		Nodes []processNode `json:"nodes"`
	}
	if err := getJSON(t, client, base+"/api/v1/nodes", &listed); err != nil || len(listed.Nodes) != 2 {
		t.Fatalf("节点数量不正确: %+v %v", listed.Nodes, err)
	}
	logs := allLogs(t) + oldCoord.out.String()
	if strings.Contains(logs, desk.Credential.Token) || strings.Contains(logs, "postgres:") {
		t.Fatal("运行日志包含凭据或数据库连接串")
	}
}

type processNode struct {
	ID            string    `json:"id"`
	Online        bool      `json:"online"`
	Synced        bool      `json:"synced"`
	Executable    bool      `json:"executable"`
	LastContact   time.Time `json:"last_contact_at"`
	StatusUpdated time.Time `json:"status_updated_at"`
}

type processAuth struct {
	ws *websocket.Conn
	protocol.Frame
}

var (
	buildDir       string
	buildOnce      sync.Once
	buildErr       error
	builtCoord     string
	builtBatond    string
	processMu      sync.Mutex
	processHandles = make(map[*testing.T][]*running)
	portMu         sync.Mutex
	reservedPorts  = make(map[string]net.Listener)
)

func buildBins(t *testing.T) (string, string) {
	t.Helper()
	buildOnce.Do(func() {
		buildMu.Lock()
		defer buildMu.Unlock()
		root, err := filepath.Abs(filepath.Join("..", ".."))
		if err != nil {
			buildErr = err
			return
		}
		out := os.Getenv("BATON_TEST_BIN_DIR")
		prebuilt := out != ""
		if !prebuilt {
			out, err = os.MkdirTemp("", "baton-relay-bins-*")
			buildDir = out
			if err != nil {
				buildErr = err
				return
			}
		}
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
		}
		if err := os.MkdirAll(out, 0o755); err != nil {
			buildErr = err
			return
		}
		for _, name := range []string{"coordinator", "batond"} {
			if prebuilt {
				if _, err := os.Stat(filepath.Join(out, name+suffix)); err != nil {
					buildErr = err
					return
				}
				continue
			}
			cmd := exec.Command("go", "test", "-c", "-o", filepath.Join(out, name+suffix), "./cmd/"+name)
			cmd.Dir = root
			if raw, err := cmd.CombinedOutput(); err != nil {
				buildErr = errString(name + ": " + string(raw) + ": " + err.Error())
				return
			}
		}
		builtCoord = filepath.Join(out, "coordinator"+suffix)
		builtBatond = filepath.Join(out, "batond"+suffix)
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return builtCoord, builtBatond
}

type errString string

func (e errString) Error() string { return string(e) }

func childEnv(extra map[string]string) []string {
	var out []string
	for _, item := range os.Environ() {
		if strings.HasPrefix(item, "BATON_") {
			continue
		}
		out = append(out, item)
	}
	for key, value := range extra {
		out = append(out, key+"="+value)
	}
	return out
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type running struct {
	cmd    *exec.Cmd
	out    *lockedBuf
	once   sync.Once
	bin    string
	exited atomic.Bool
}

func startCmd(t *testing.T, bin string, args, env []string) *running {
	t.Helper()
	buf := &lockedBuf{}
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	cmd.Stdout = buf
	cmd.Stderr = buf
	if len(args) > 0 && args[0] == "serve" {
		for _, item := range env {
			if addr, ok := strings.CutPrefix(item, "BATON_HTTP_ADDR="); ok && !strings.HasSuffix(addr, ":0") {
				portMu.Lock()
				defer portMu.Unlock()
				releasePort(addr)
			}
		}
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	proc := &running{cmd: cmd, out: buf, bin: bin}
	trackProcess(t, proc)
	t.Cleanup(func() {
		proc.stop()
		if len(args) > 0 && args[0] == "run" {
			for i, arg := range args {
				if arg == "--data-dir" && i+1 < len(args) {
					if err := cleanupSessionWorkers(args[i+1]); err != nil {
						t.Errorf("清理 Session Worker: %v", err)
					}
					break
				}
			}
		}
	})
	if len(args) > 0 && args[0] == "serve" {
		proc.listenAddr(t)
	}
	return proc
}

func latestProc(t *testing.T, bin string) *running {
	t.Helper()
	processMu.Lock()
	defer processMu.Unlock()
	owned := processHandles[t]
	for i := len(owned) - 1; i >= 0; i-- {
		if owned[i].bin == bin && !owned[i].exited.Load() {
			return owned[i]
		}
	}
	t.Fatal("没有找到进程")
	return nil
}

func (p *running) stop() {
	if p == nil || p.cmd.Process == nil || p.exited.Load() {
		return
	}
	_ = terminateProcess(p.cmd.Process)
	done := make(chan struct{})
	go func() {
		p.wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		_ = p.cmd.Process.Kill()
		<-done
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	portMu.Lock()
	defer portMu.Unlock()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	reservedPorts[addr] = ln
	t.Cleanup(func() {
		portMu.Lock()
		defer portMu.Unlock()
		releasePort(addr)
	})
	return addr
}

func waitListen(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("端口未开始监听: %s", addr)
}

func portClosed(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
	if err == nil {
		conn.Close()
		return false
	}
	return true
}

func tlsClient(t *testing.T, roots *x509.CertPool) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{
		Jar:     jar,
		Timeout: 10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    roots,
		}},
	}
}

func login(t *testing.T, client *http.Client, base, username, password string) string {
	t.Helper()
	var parsed struct {
		CSRF string `json:"csrf_token"`
	}
	code := postJSON(t, client, base+"/api/v1/login", map[string]string{"username": username, "password": password}, "", &parsed)
	if code != http.StatusOK || parsed.CSRF == "" {
		t.Fatalf("登录状态 %d", code)
	}
	return parsed.CSRF
}

func registerThrough(t *testing.T, client *http.Client, base, csrf, name string) node.Identity {
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
		"capabilities":     []string{"pi"},
	}, "", &ident)
	if code != http.StatusOK || ident.NodeID == "" || ident.Credential.Token == "" {
		t.Fatalf("注册状态 %d", code)
	}
	return ident
}

func postJSON(t *testing.T, client *http.Client, rawURL string, payload any, csrf string, dest any) int {
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
	if dest != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if err := json.Unmarshal(raw, dest); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func getJSON(t *testing.T, client *http.Client, rawURL string, dest any) error {
	t.Helper()
	resp, err := client.Get(rawURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errString("状态不是 200")
	}
	return json.NewDecoder(resp.Body).Decode(dest)
}

func waitNode(t *testing.T, client *http.Client, base, id string, online, synced, executable bool) processNode {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last processNode
	for time.Now().Before(deadline) {
		if err := getJSON(t, client, base+"/api/v1/nodes/"+id, &last); err == nil && last.Online == online && last.Synced == synced && last.Executable == executable {
			return last
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("节点 %s 状态没有达到 online=%t synced=%t executable=%t，最后是 %+v", id, online, synced, executable, last)
	return last
}

func authProcess(t *testing.T, addr, token, incarnation string, roots *x509.CertPool) processAuth {
	t.Helper()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}}
	ws, _, err := websocket.Dial(context.Background(), "wss://"+addr+protocol.NodePath, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(protocol.MaxMessageBytes)
	raw, _ := json.Marshal(protocol.Frame{Kind: protocol.KindAuth, Token: token, Incarnation: incarnation})
	if err := ws.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
	_, resp, err := ws.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var frame protocol.Frame
	if err := json.Unmarshal(resp, &frame); err != nil {
		t.Fatal(err)
	}
	if !frame.OK {
		ws.Close(websocket.StatusNormalClosure, "")
	}
	return processAuth{ws: ws, Frame: frame}
}

func sendProcessEnvelope(t *testing.T, ws *websocket.Conn, env any) {
	t.Helper()
	body, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(protocol.Frame{Kind: protocol.KindEnvelope, Envelope: body})
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
}

func readProcess(t *testing.T, ws *websocket.Conn) protocol.Frame {
	t.Helper()
	_, raw, err := ws.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var frame protocol.Frame
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func listenDelivered(ws *websocket.Conn) func() bool {
	got := make(chan struct{}, 4)
	go func() {
		for {
			_, _, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			got <- struct{}{}
		}
	}()
	return func() bool {
		select {
		case <-got:
			return true
		case <-time.After(400 * time.Millisecond):
			return false
		}
	}
}

func waitCount(t *testing.T, proc *running, needle string, want int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Count(proc.out.String(), needle) >= want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("日志里 %s 没有达到 %d 次", needle, want)
}

func allLogs(t *testing.T) string {
	t.Helper()
	processMu.Lock()
	defer processMu.Unlock()
	var b strings.Builder
	for _, proc := range processHandles[t] {
		b.WriteString(proc.out.String())
	}
	return b.String()
}

func newProcessID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

type tcpProxy struct {
	ln    net.Listener
	mu    sync.Mutex
	conns []net.Conn
}

func newProxy(t *testing.T, dst string) *tcpProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &tcpProxy{ln: ln}
	go func() {
		for {
			client, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", dst)
			if err != nil {
				client.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, client, up)
			p.mu.Unlock()
			go proxyCopy(client, up)
			go proxyCopy(up, client)
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		p.drop()
	})
	return p
}

func proxyCopy(dst, src net.Conn) {
	_, _ = io.Copy(dst, src)
	_ = dst.Close()
	_ = src.Close()
}

func (p *tcpProxy) addr() string { return p.ln.Addr().String() }

func (p *tcpProxy) drop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, conn := range p.conns {
		_ = conn.Close()
	}
	p.conns = nil
}

// cleanupSessionWorkers 在测试节点退出后结束其 Worker，等待初始化中的 Worker 开始提供认证 IPC。
func cleanupSessionWorkers(dataDir string) error {
	paths, err := filepath.Glob(filepath.Join(dataDir, "sessions", "*", "token"))
	if err != nil {
		return err
	}
	var failures []error
	for _, path := range paths {
		sessionID := filepath.Base(filepath.Dir(path))
		token, err := os.ReadFile(path)
		if err != nil {
			failures = append(failures, fmt.Errorf("Session %s 读取令牌: %w", sessionID, err))
			continue
		}
		// Agent 初始化最多 30 秒，Close 最多再等待 2 秒。
		ctx, cancel := context.WithTimeout(context.Background(), 32*time.Second)
		err = cleanupSessionWorker(ctx, dataDir, sessionID, strings.TrimSpace(string(token)))
		cancel()
		if err != nil {
			failures = append(failures, fmt.Errorf("Session %s: %w", sessionID, err))
		}
	}
	return errors.Join(failures...)
}

func cleanupSessionWorker(ctx context.Context, dataDir, sessionID, token string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	endpoint, err := session.Endpoint(dataDir, sessionID)
	if err != nil {
		return err
	}
	lockPath, err := session.LockPath(dataDir, sessionID)
	if err != nil {
		return err
	}
	lock := flock.New(lockPath)
	defer lock.Close()
	lockFree := func() (bool, error) {
		free, err := lock.TryLock()
		if err != nil || !free {
			return false, err
		}
		return true, lock.Unlock()
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
retry:
	for {
		probeCtx, cancel := context.WithTimeout(ctx, time.Second)
		client, err := session.Dial(probeCtx, endpoint, token)
		var status session.Status
		if err == nil {
			status, err = client.Status()
			_ = client.Close()
		}
		cancel()
		if err == nil {
			if status.PID <= 0 || status.SessionID != sessionID {
				return errors.New("Worker 认证状态中的进程或 Session 标识无效")
			}
			exitCtx, exitCancel := context.WithTimeout(ctx, 5*time.Second)
			defer exitCancel()
			if err := stopWorkerContext(exitCtx, status.PID); err != nil {
				return fmt.Errorf("终止 Worker %d: %w", status.PID, err)
			}
			for {
				free, err := lockFree()
				if err != nil {
					return fmt.Errorf("检查 Worker 锁释放: %w", err)
				}
				if free && processAlive(status.PID) != nil {
					starting, err := sessionWorkerStarting(exitCtx, dataDir, sessionID)
					if err != nil {
						return err
					}
					if !starting {
						return nil
					}
					continue retry
				}
				select {
				case <-exitCtx.Done():
					return fmt.Errorf("Worker %d 未确认退出或释放会话锁: %w", status.PID, exitCtx.Err())
				case <-ticker.C:
				}
			}
		}
		lastErr = err
		free, err := lockFree()
		if err != nil {
			return fmt.Errorf("检查 Worker 会话锁: %w", err)
		}
		if free {
			probeCtx, cancel := context.WithTimeout(ctx, time.Second)
			conn, dialErr := session.DialLocal(probeCtx, endpoint)
			cancel()
			if dialErr != nil {
				starting, err := sessionWorkerStarting(ctx, dataDir, sessionID)
				if err != nil {
					return err
				}
				if !starting {
					return nil
				}
			} else {
				_ = conn.Close()
				return fmt.Errorf("会话锁空闲但 IPC 仍可连接，无法确认 Worker 身份: %w", lastErr)
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Worker 已启动或持有会话锁，但认证 IPC 未就绪: %w", errors.Join(ctx.Err(), lastErr))
		case <-ticker.C:
		}
	}
}

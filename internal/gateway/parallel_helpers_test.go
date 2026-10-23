package gateway_test

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func trackProcess(t *testing.T, proc *running) {
	t.Helper()
	processMu.Lock()
	defer processMu.Unlock()
	if _, ok := processHandles[t]; !ok {
		t.Cleanup(func() {
			processMu.Lock()
			delete(processHandles, t)
			processMu.Unlock()
		})
	}
	processHandles[t] = append(processHandles[t], proc)
}

func (p *running) wait() {
	p.once.Do(func() {
		_ = p.cmd.Wait()
		p.exited.Store(true)
	})
}

func (p *running) listenAddr(t *testing.T) string {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		for _, line := range strings.Split(p.out.String(), "\n") {
			if !strings.Contains(line, "event=listening") || !strings.Contains(line, "kind=http") {
				continue
			}
			for _, field := range strings.Fields(line) {
				if addr, ok := strings.CutPrefix(field, "addr="); ok {
					addr = strings.Trim(addr, `"`)
					waitListen(t, addr)
					return addr
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("Coordinator 未报告监听地址：%s", p.out.String())
	return ""
}

func setChildEnv(env []string, key, value string) {
	for i, item := range env {
		if strings.HasPrefix(item, key+"=") {
			env[i] = key + "=" + value
			return
		}
	}
}

// releasePort 在持有 portMu 时交接预留端口；启动方在监听就绪后释放锁。
func releasePort(addr string) {
	if ln := reservedPorts[addr]; ln != nil {
		_ = ln.Close()
		delete(reservedPorts, addr)
	}
}

func (env *revokeEnv) startCoordinator(t *testing.T, bin string) *running {
	t.Helper()
	proc := startCmd(t, bin, []string{"serve"}, env.coord)
	env.apiAddr = proc.listenAddr(t)
	env.nodeAddr = env.apiAddr
	setChildEnv(env.coord, "BATON_HTTP_ADDR", env.apiAddr)
	return proc
}

var (
	fixtureDirOnce sync.Once
	fixtureDir     string
	fixtureDirErr  error
	fixtureBuilds  sync.Map
	buildMu        sync.Mutex
)

type fixtureBuild struct {
	once sync.Once
	path string
	err  error
}

// buildFixture 共享只读可执行文件；调用方负责隔离配置和运行目录。
func buildFixture(t *testing.T, source, name string, testBinary ...bool) string {
	t.Helper()
	fixtureDirOnce.Do(func() {
		fixtureDir, fixtureDirErr = os.MkdirTemp("", "baton-gateway-fixtures-*")
	})
	if fixtureDirErr != nil {
		t.Fatal(fixtureDirErr)
	}
	isTest := len(testBinary) > 0 && testBinary[0]
	value, _ := fixtureBuilds.LoadOrStore(fmt.Sprintf("%s:%t", source, isTest), &fixtureBuild{})
	built := value.(*fixtureBuild)
	built.once.Do(func() {
		buildMu.Lock()
		defer buildMu.Unlock()
		built.path = filepath.Join(fixtureDir, name+realExecutableSuffix())
		args := []string{"build", "-o", built.path, source}
		if isTest {
			args = []string{"test", "-c", "-o", built.path, source}
		}
		cmd := exec.Command("go", args...)
		if raw, err := cmd.CombinedOutput(); err != nil {
			built.err = fmt.Errorf("构建 %s：%w %s", source, err, raw)
		}
	})
	if built.err != nil {
		t.Fatal(built.err)
	}
	return built.path
}

func startProjectStack(t *testing.T, extra map[string]string) *processStack {
	t.Helper()
	coord, batond := buildProjectBins(t)
	return startThreadStackWithBins(t, extra, coord, batond)
}

// Project 测试使用注入短租约的测试二进制，覆盖配置不参与这组构建。
func buildProjectBins(t *testing.T) (string, string) {
	t.Helper()
	if os.Getenv("BATON_TEST_BIN_DIR") == "" {
		return buildBins(t)
	}
	return buildFixture(t, "../../cmd/baton-server", "baton-server", true), buildFixture(t, "../../cmd/batond", "batond", true)
}

func installProjectRuntime(t *testing.T, dir string) {
	t.Helper()
	binary := buildFixture(t, "./testdata/project_runtime.go", "baton-project-runtime")
	raw, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, filepath.Base(binary)), raw, 0o700); err != nil {
		t.Fatal(err)
	}
}

func TestProcessHandlesAndLogsStayWithinTest(t *testing.T) {
	t.Parallel()
	for _, label := range []string{"scope-a", "scope-b"} {
		t.Run(label, func(t *testing.T) {
			proc, _ := startIdleProcess(t, 0, "BATON_TEST_PROCESS_LABEL="+label)
			t.Parallel()
			if got := latestProc(t, proc.bin); got != proc {
				t.Fatal("进程查询越过了测试作用域")
			}
			logs := allLogs(t)
			other := "scope-a"
			if label == other {
				other = "scope-b"
			}
			if !strings.Contains(logs, label) || strings.Contains(logs, other) {
				t.Fatal("日志查询混入了其他测试的输出")
			}
		})
	}
}

func TestLatestProcSkipsExitedProcess(t *testing.T) {
	t.Parallel()
	first, _ := startIdleProcess(t, 0)
	second, _ := startIdleProcess(t, 0)
	second.stop()
	if latestProc(t, first.bin) != first {
		t.Fatal("进程查询返回了已退出的进程")
	}
}

func TestFreeAddrKeepsPortReserved(t *testing.T) {
	t.Parallel()
	addr := freeAddr(t)
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		ln.Close()
		t.Fatal("预留端口被提前释放")
	}
}

// reservedAddr 返回 PostgreSQL 等要求固定端口的进程所持有的预留地址。
func reservedAddr(port int) string {
	return net.JoinHostPort("127.0.0.1", fmt.Sprint(port))
}

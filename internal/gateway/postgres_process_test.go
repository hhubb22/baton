package gateway_test

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

type privatePostgres struct {
	dir  string
	url  string
	port int
	bin  string
	user string
}

func startPrivatePostgres(t *testing.T) *privatePostgres {
	t.Helper()
	bin, user := postgresBinDir(t)
	base := t.TempDir()
	parent := filepath.Dir(base)
	if parent != os.TempDir() {
		if err := os.Chmod(parent, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(base, 0o755); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "pg")
	if user != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		account, err := userLookup(user)
		if err != nil {
			t.Skipf("找不到运行数据库的用户 %s: %v", user, err)
		}
		if err := os.Chown(dir, account.uid, account.gid); err != nil {
			t.Fatal(err)
		}
	}
	if err := runPostgres(user, filepath.Join(bin, "initdb"), "-D", dir, "-A", "trust", "--locale=C", "--encoding=UTF8", "--username="+postgresRole(user)); err != nil {
		t.Fatalf("initdb: %v", err)
	}
	hba := "host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n"
	if runtime.GOOS != "windows" {
		hba = "local all all trust\n" + hba
	}
	if err := os.WriteFile(filepath.Join(dir, "pg_hba.conf"), []byte(hba), 0o600); err != nil {
		t.Fatal(err)
	}
	_, rawPort, err := net.SplitHostPort(freeAddr(t))
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil {
		t.Fatal(err)
	}
	role := postgresRole(user)
	hbaPath := filepath.Join(dir, "pg_hba.conf")
	if user != "" {
		account, err := userLookup(user)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(hbaPath, account.uid, account.gid); err != nil {
			t.Fatal(err)
		}
	}
	pg := &privatePostgres{
		dir: dir, port: port, bin: bin, user: user,
		url: fmt.Sprintf("postgres://%s@127.0.0.1:%d/postgres?sslmode=disable", role, port),
	}
	pg.start(t)
	t.Cleanup(func() { pg.stop(t) })
	return pg
}

func (p *privatePostgres) start(t *testing.T) {
	t.Helper()
	portMu.Lock()
	defer portMu.Unlock()
	releasePort(reservedAddr(p.port))
	options := fmt.Sprintf("-p %d -h 127.0.0.1", p.port)
	if runtime.GOOS != "windows" {
		options += " -k ''"
	}
	if err := runPostgresCtl(p.user, p.dir, p.bin, "start", "-w", "-o", options); err != nil {
		t.Fatal(err)
	}
}

func (p *privatePostgres) stop(t *testing.T) {
	t.Helper()
	err := runPostgresCtl(p.user, p.dir, p.bin, "stop", "-m", "fast", "-w")
	if err != nil && !strings.Contains(err.Error(), "no server running") {
		t.Fatal(err)
	}
}

func postgresBinDir(t *testing.T) (string, string) {
	t.Helper()
	bin := strings.TrimSpace(os.Getenv("BATON_TEST_POSTGRES_BINDIR"))
	if bin == "" {
		pgConfig, err := exec.LookPath("pg_config")
		if err != nil {
			t.Skip("没有 pg_config，也没有 BATON_TEST_POSTGRES_BINDIR，跳过独立数据库停机测试")
		}
		out, err := exec.Command(pgConfig, "--bindir").Output()
		if err != nil {
			t.Skipf("pg_config --bindir 失败: %v", err)
		}
		bin = strings.TrimSpace(string(out))
	}
	if _, err := exec.LookPath(filepath.Join(bin, "initdb")); err != nil {
		t.Skipf("找不到 initdb（%s），跳过独立数据库停机测试", bin)
	}
	if os.Geteuid() != 0 {
		return bin, ""
	}
	if _, err := exec.LookPath("runuser"); err != nil {
		t.Skip("当前是 root，且没有 runuser，跳过独立数据库停机测试")
	}
	if _, err := user.Lookup("postgres"); err != nil {
		t.Skip("当前是 root，且没有 postgres 用户，跳过独立数据库停机测试")
	}
	return bin, "postgres"
}

func postgresRole(runAs string) string {
	if runAs != "" {
		return runAs
	}
	if runtime.GOOS == "windows" {
		return "postgres"
	}
	current, err := user.Current()
	if err != nil || current.Username == "" {
		return "postgres"
	}
	return current.Username
}

type systemAccount struct {
	uid int
	gid int
}

func userLookup(name string) (systemAccount, error) {
	account, err := user.Lookup(name)
	if err != nil {
		return systemAccount{}, err
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return systemAccount{}, err
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return systemAccount{}, err
	}
	return systemAccount{uid: uid, gid: gid}, nil
}

func runPostgres(runAs, bin string, args ...string) error {
	var cmd *exec.Cmd
	if runAs == "" {
		cmd = exec.Command(bin, args...)
	} else {
		cmd = exec.Command("runuser", append([]string{"-u", runAs, "--", bin}, args...)...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v %s", filepath.Base(bin), err, out)
	}
	return nil
}

func runPostgresCtl(runAs, dir, bin, action string, args ...string) error {
	logFile, err := os.OpenFile(filepath.Join(dir, "ctl.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer logFile.Close()
	if runAs != "" {
		if account, err := userLookup(runAs); err == nil {
			_ = os.Chown(logFile.Name(), account.uid, account.gid)
		}
	}
	argv := []string{"-D", dir, "-l", filepath.Join(dir, "server.log"), action}
	argv = append(argv, args...)
	var cmd *exec.Cmd
	if runAs == "" {
		cmd = exec.Command(filepath.Join(bin, "pg_ctl"), argv...)
	} else {
		cmd = exec.Command("runuser", append([]string{"-u", runAs, "--", filepath.Join(bin, "pg_ctl")}, argv...)...)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Run(); err != nil {
		logged, _ := os.ReadFile(filepath.Join(dir, "ctl.log"))
		server, _ := os.ReadFile(filepath.Join(dir, "server.log"))
		return fmt.Errorf("pg_ctl %s: %v %s %s", action, err, logged, server)
	}
	return nil
}

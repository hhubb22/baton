package relay_test

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/agent/pi"
)

func piSandboxPolicy(readDirs, writeDirs []string, endpoint string) string {
	var policy strings.Builder
	policy.WriteString("(version 1)\n(deny default)\n(import \"bsd.sb\")\n(deny file-read* file-write*)\n(allow process* sysctl-read mach-lookup network*)\n(allow file-read-metadata)\n(allow file-read* (literal \"/\"))\n")
	readDirs = append([]string{"/System", "/usr", "/bin", "/sbin", "/Library", "/opt/homebrew", "/private/etc", "/dev", "/private/var/db", "/private/var/select"}, readDirs...)
	for _, dir := range readDirs {
		fmt.Fprintf(&policy, "(allow file-read* (subpath %s))\n", strconv.Quote(dir))
	}
	for _, dir := range writeDirs {
		fmt.Fprintf(&policy, "(allow file-write* (subpath %s))\n", strconv.Quote(dir))
	}
	physicalEndpoint := strings.Replace(endpoint, "/tmp/", "/private/tmp/", 1)
	fmt.Fprintf(&policy, "(allow file-read* file-write* (literal %s) (literal %s) (literal \"/dev/null\"))\n", strconv.Quote(endpoint), strconv.Quote(physicalEndpoint))
	// Imported leaf rules need filtered denials of the same operation.
	for _, rule := range []struct {
		operations string
		dirs       []string
		literals   []string
	}{
		{"file-read-data file-read-xattr", readDirs, []string{"/", endpoint, physicalEndpoint, "/dev/null"}},
		{"file-write* file-write-data", writeDirs, []string{endpoint, physicalEndpoint, "/dev/null"}},
	} {
		fmt.Fprintf(&policy, "(deny %s (require-not (require-any\n", rule.operations)
		for _, dir := range rule.dirs {
			fmt.Fprintf(&policy, "  (subpath %s)\n", strconv.Quote(dir))
		}
		for _, path := range rule.literals {
			fmt.Fprintf(&policy, "  (literal %s)\n", strconv.Quote(path))
		}
		policy.WriteString(")))\n")
	}
	return policy.String()
}

func piSandboxRuntimeDir(binary string) string {
	dir := filepath.Dir(binary)
	for parent := dir; parent != filepath.Dir(parent); parent = filepath.Dir(parent) {
		if filepath.Base(filepath.Dir(parent)) == "node_modules" ||
			(strings.HasPrefix(filepath.Base(filepath.Dir(parent)), "@") && filepath.Base(filepath.Dir(filepath.Dir(parent))) == "node_modules") {
			return parent
		}
	}
	return dir
}

func runPiSandbox(profile, home string, args ...string) (int, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", append([]string{"-f", profile}, args...)...)
	cmd.Env = pi.IsolatedEnv(home)
	cmd.Dir = home
	return piSandboxCommandResult(cmd)
}

func piSandboxCommandResult(cmd *exec.Cmd) (int, string, error) {
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return code, strings.TrimSpace(stderr.String()), err
}

func checkPiSandbox(t *testing.T, profile, root string) {
	t.Helper()
	home := filepath.Join(root, "home")
	inside := filepath.Join(root, "work", "sandbox-check")
	defer os.Remove(inside)
	// A startup crash must not count as proof that an outside read was denied.
	code, stderr, err := runPiSandbox(profile, home, "/bin/sh", "-c", `printf ok > "$1" && test "$(/bin/cat "$1")" = ok`, "sh", inside)
	if err != nil {
		t.Fatalf("sandbox unavailable; refusing unsandboxed execution: exit_code=%d error=%v stderr=%q", code, err, stderr)
	}
	// bsd.sb normally grants this filename access outside the chosen roots.
	outside := filepath.Join(t.TempDir(), ".CFUserTextEncoding")
	const sentinel = "isolated-test-sentinel"
	if err := os.WriteFile(outside, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(root, "work", "sandbox-escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(escape)
	for _, path := range []string{outside, escape} {
		code, stderr, err := runPiSandbox(profile, home, "/bin/sh", "-c", `if /bin/cat "$1" > /dev/null; then exit 0; else exit 73; fi`, "sh", path)
		if code != 73 {
			t.Fatalf("sandbox outside read check failed: exit_code=%d error=%v stderr=%q", code, err, stderr)
		}
	}
	code, stderr, err = runPiSandbox(profile, home, "/bin/sh", "-c", `if printf changed > "$1"; then exit 0; else exit 73; fi`, "sh", outside)
	if code != 73 {
		t.Fatalf("sandbox outside write check failed: exit_code=%d error=%v stderr=%q", code, err, stderr)
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != sentinel {
		t.Fatal("sandbox changed the outside sentinel")
	}
}

func TestPiSandboxPolicy(t *testing.T) {
	policy := piSandboxPolicy([]string{"/isolated"}, []string{"/isolated/work"}, "/tmp/pi.sock")
	for _, rule := range []string{
		"(deny default)\n(import \"bsd.sb\")\n(deny file-read* file-write*)",
		`(allow file-read* (subpath "/isolated"))`,
		`(allow file-write* (subpath "/isolated/work"))`,
		`(literal "/tmp/pi.sock") (literal "/private/tmp/pi.sock")`,
		"(deny file-read-data file-read-xattr (require-not (require-any\n",
		"(deny file-write* file-write-data (require-not (require-any\n",
	} {
		if !strings.Contains(policy, rule) {
			t.Fatalf("missing sandbox rule %s", rule)
		}
	}
	if strings.Contains(policy, "(allow default)") {
		t.Fatal("sandbox must not allow all operations")
	}
}

func TestPiSandboxRuntimeDir(t *testing.T) {
	root := t.TempDir()
	for _, parts := range [][]string{
		{"node_modules", "@vendor", "pi", "dist", "src", "cli.js"},
		{"node_modules", "pi", "dist", "cli.js"},
		{"bin", "pi"},
	} {
		binary := filepath.Join(append([]string{root}, parts...)...)
		want := filepath.Join(root, "bin")
		if parts[0] == "node_modules" {
			want = filepath.Join(root, "node_modules", "pi")
			if parts[1] == "@vendor" {
				want = filepath.Join(root, "node_modules", "@vendor", "pi")
			}
		}
		if got := piSandboxRuntimeDir(binary); got != want {
			t.Fatalf("runtime directory escaped its package: got %q want %q", got, want)
		}
	}
}

func TestPiSandbox(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("requires macOS sandbox-exec; no model or database needed")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"home/tmp", "work"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	profile := filepath.Join(root, "pi.sb")
	if err := os.WriteFile(profile, []byte(piSandboxPolicy([]string{root}, []string{filepath.Join(root, "home"), filepath.Join(root, "work")}, filepath.Join(root, "pi.sock"))), 0o600); err != nil {
		t.Fatal(err)
	}
	if release, err := exec.Command("/usr/bin/uname", "-r").Output(); err == nil {
		t.Logf("platform=%s/%s Darwin=%s", runtime.GOOS, runtime.GOARCH, strings.TrimSpace(string(release)))
	}
	checkPiSandbox(t, profile, root)
}

func TestPiSandboxStartupDiagnostics(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("requires macOS sandbox-exec; no model or database needed")
	}
	root := t.TempDir()
	profile, wrapper := filepath.Join(root, "invalid.sb"), filepath.Join(root, "pi-wrapper")
	if err := os.WriteFile(profile, []byte("("), 0o600); err != nil {
		t.Fatal(err)
	}
	quote := "'" + strings.ReplaceAll(profile, "'", "'\"'\"'") + "'"
	script := "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' " + pi.Version + "; exit 0; fi\nexec /usr/bin/sandbox-exec -f " + quote + " /usr/bin/true\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	a := pi.New(agent.Config{Binary: wrapper, Directory: root, SessionDir: filepath.Join(root, "native"), SessionID: "diagnostic-fixture", Env: pi.IsolatedEnv(root)}, pi.WithDiagnostics())
	t.Cleanup(func() { _ = a.Close() })
	err := a.Start(context.Background())
	if err == nil {
		t.Fatal("invalid sandbox profile unexpectedly started")
	}
	d := a.Diagnostics(err)
	if !strings.Contains(d, "phase=rpc") || !strings.Contains(d, "exited=true") || !strings.Contains(d, "sandbox-exec:") || !strings.Contains(d, "syntax error") || strings.Contains(d, "exit_code=0 ") {
		t.Fatal(d)
	}
}

func TestPiSandboxDiagnostic(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestPiSandboxDiagnosticChild$")
	cmd.Env = append(os.Environ(), "BATON_TEST_SANDBOX_DIAGNOSTIC=1")
	code, stderr, err := piSandboxCommandResult(cmd)
	if code != 23 || stderr != "sandbox diagnostic fixture" || err == nil {
		t.Fatalf("sandbox failure diagnostics lost: exit_code=%d error=%v stderr=%q", code, err, stderr)
	}
}

func TestPiSandboxDiagnosticChild(t *testing.T) {
	if os.Getenv("BATON_TEST_SANDBOX_DIAGNOSTIC") != "1" {
		t.Skip("subprocess fixture")
	}
	fmt.Fprintln(os.Stderr, "sandbox diagnostic fixture")
	os.Exit(23)
}

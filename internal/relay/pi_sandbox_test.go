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

	"baton/internal/agent/pi"
)

func piSandboxPolicy(readDirs, writeDirs []string, endpoint string) string {
	var policy strings.Builder
	// Keep Apple's process-startup permissions, not its filesystem exceptions.
	policy.WriteString("(version 1)\n(deny default)\n(import \"bsd.sb\")\n(deny file-read* file-write*)\n(allow process* sysctl-read mach-lookup network*)\n(allow file-read-metadata)\n(allow file-read* (literal \"/\"))\n")
	for _, dir := range append([]string{"/System", "/usr", "/bin", "/sbin", "/Library", "/opt/homebrew", "/private/etc", "/dev", "/private/var/db", "/private/var/select"}, readDirs...) {
		fmt.Fprintf(&policy, "(allow file-read* (subpath %s))\n", strconv.Quote(dir))
	}
	for _, dir := range writeDirs {
		fmt.Fprintf(&policy, "(allow file-write* (subpath %s))\n", strconv.Quote(dir))
	}
	physicalEndpoint := strings.Replace(endpoint, "/tmp/", "/private/tmp/", 1)
	fmt.Fprintf(&policy, "(allow file-read* file-write* (literal %s) (literal %s) (literal \"/dev/null\"))\n", strconv.Quote(endpoint), strconv.Quote(physicalEndpoint))
	return policy.String()
}

func runPiSandbox(profile, home string, args ...string) (int, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", append([]string{"-f", profile}, args...)...)
	cmd.Env = pi.IsolatedEnv(home)
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
	} {
		if !strings.Contains(policy, rule) {
			t.Fatalf("missing sandbox rule %s", rule)
		}
	}
	if strings.Contains(policy, "(allow default)") {
		t.Fatal("sandbox must not allow all operations")
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

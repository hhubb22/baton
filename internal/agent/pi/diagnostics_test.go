package pi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"baton/internal/agent"
)

const diagnosticFixtureToken = "untrusted-fixture-0123456789-ABCDEFGHIJKLMN"

func diagnosticChild(mode string) {
	version := len(os.Args) > 1 && os.Args[1] == "--version"
	if version && mode != "version" {
		fmt.Println(Version)
		return
	}
	fmt.Fprintln(os.Stderr, "GOOGLE_CLOUD_API_KEY="+os.Getenv("GOOGLE_CLOUD_API_KEY"))
	fmt.Fprintln(os.Stderr, diagnosticFixtureToken)
	fmt.Fprintln(os.Stderr, "sandbox-exec: file-read-data /isolated/runtime/module.js: Operation not permitted")
	if mode == "reject" {
		_ = readFrames(os.Stdin, func(raw []byte) error {
			var cmd map[string]any
			_ = json.Unmarshal(raw, &cmd)
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "response", "id": cmd["id"], "command": cmd["type"], "success": false})
		})
		return
	}
	if mode == "signal" {
		p, _ := os.FindProcess(os.Getpid())
		_ = p.Kill()
	}
	os.Exit(23)
}

func diagnosticAdapter(t *testing.T, mode string, options ...Option) *Adapter {
	t.Helper()
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	a := New(agent.Config{Binary: exe, Directory: dir, SessionDir: filepath.Join(dir, "native"), SessionID: "diagnostic-fixture",
		Env: append(os.Environ(), "BATON_PI_DIAGNOSTIC_CHILD="+mode, "GOOGLE_CLOUD_API_KEY=tiny-fixture-key")}, options...)
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func TestPiStartupDiagnostics(t *testing.T) {
	for _, mode := range []string{"version", "rpc", "reject", "signal"} {
		t.Run(mode, func(t *testing.T) {
			a := diagnosticAdapter(t, mode, WithDiagnostics())
			err := a.Start(context.Background())
			if err == nil {
				t.Fatal("expected startup failure")
			}
			d := a.Diagnostics(err)
			for _, want := range []string{"error=", "exited=true", "sandbox-exec:", "file-read-data /isolated/runtime/module.js", "Operation not permitted", "[redacted]"} {
				if !strings.Contains(d, want) {
					t.Fatalf("missing %q: %s", want, d)
				}
			}
			for _, secret := range []string{"tiny-fixture-key", diagnosticFixtureToken} {
				if strings.Contains(d, secret) {
					t.Fatal("credential leaked in startup diagnostic")
				}
			}
			if mode == "version" {
				if !strings.Contains(d, "phase=version") || !strings.Contains(d, "exit_code=23") || !strings.Contains(d, "version check failed") {
					t.Fatal(d)
				}
			} else if !strings.Contains(d, "phase=rpc") || !strings.Contains(d, "set_auto_retry") {
				t.Fatal(d)
			} else if mode == "rpc" && !strings.Contains(d, "exit_code=23") {
				t.Fatal(d)
			} else if mode == "reject" && (!strings.Contains(d, "Pi command rejected") || !strings.Contains(d, "exit_code=0")) {
				t.Fatal(d)
			} else if mode == "signal" && runtime.GOOS != "windows" && (!strings.Contains(d, "exit_code=-1") || !strings.Contains(d, "signal: killed")) {
				t.Fatal(d)
			}
		})
	}
}

func TestPiDiagnosticsDisabledByDefault(t *testing.T) {
	a := diagnosticAdapter(t, "rpc")
	if err := a.Start(context.Background()); err == nil {
		t.Fatal("expected failure")
	}
	if a.diagnostic != nil || a.cmd.Stderr != io.Discard {
		t.Fatal("production adapter retained stderr without opt-in")
	}
}

func TestPiDiagnosticNoExitStatus(t *testing.T) {
	dir := t.TempDir()
	a := New(agent.Config{Binary: filepath.Join(dir, "missing-pi"), Directory: dir, SessionDir: filepath.Join(dir, "native"), SessionID: "diagnostic-fixture"}, WithDiagnostics())
	err := a.Start(context.Background())
	if err == nil {
		t.Fatal("expected process creation failure")
	}
	d := a.Diagnostics(err)
	if !strings.Contains(d, "phase=version") || !strings.Contains(d, "exited=false exit_code=unavailable") || !strings.Contains(d, "missing-pi") {
		t.Fatal(d)
	}
}

func TestPiDiagnosticUsesChildEnvironment(t *testing.T) {
	a := New(agent.Config{}, WithDiagnostics())
	a.diagnostic.configure([]string{"GOOGLE_CLOUD_API_KEY=old-short-key"})
	cmd := exec.Command(os.Args[0])
	cmd.Env = []string{"GOOGLE_CLOUD_API_KEY=current-short-key"}
	a.captureStderr(cmd, "rpc")
	_, _ = io.WriteString(cmd.Stderr, "current-short-key")
	if strings.Contains(a.Diagnostics(errors.New("startup failed")), "current-short-key") {
		t.Fatal("diagnostics did not redact the command's current credential")
	}
}

func TestPiDiagnosticsScrubAndTail(t *testing.T) {
	a := New(agent.Config{}, WithDiagnostics())
	d := a.diagnostic
	d.configure([]string{"GOOGLE_CLOUD_API_KEY=tiny-key", "OTHER_TOKEN=tiny-key-suffix"})
	_, _ = io.WriteString(d, strings.Repeat("old-line\n", 100))
	_, _ = io.WriteString(d, "bare tiny-key-suffix; tiny-")
	_, _ = io.WriteString(d, "key\n"+diagnosticFixtureToken+"\napi_key: short-key\n{\"access_token\":\"short-token\"}\nAuthorization: Bearer short-auth\nAuthorization: Basic YWJjOmRlZg==\n{\"secret\":\"escaped\\\"credential\"}\nhttps://user:pass@example.invalid/error\n")
	_, _ = io.WriteString(d, "\x1b[31mtiny-key\x1b[0m\nretained error\n")
	s := a.Diagnostics(errors.New("failed tiny-key-suffix " + diagnosticFixtureToken))
	for _, secret := range []string{"tiny-key", "suffix", diagnosticFixtureToken, "short-key", "short-token", "short-auth", "YWJjOmRlZg==", "escaped", "user:pass"} {
		if strings.Contains(s, secret) {
			t.Fatal("secret leaked in redacted diagnostic")
		}
	}
	if strings.Count(s, "old-line") > diagnosticLines || !strings.Contains(s, "retained error") || !strings.Contains(s, "stderr_truncated=true") {
		t.Fatal(s)
	}
	// A byte limit must not expose the suffix of a cut credential or line.
	d.tail, d.truncated = nil, false
	_, _ = io.WriteString(d, strings.Repeat("x", diagnosticBytes)+"tiny-key-suffix")
	if len(d.tail) > diagnosticBytes || strings.Contains(a.Diagnostics(nil), "suffix") {
		t.Fatal("truncated first line leaked")
	}
	_, _ = io.WriteString(d, "\nlast error\n")
	if !strings.Contains(a.Diagnostics(nil), "last error") {
		t.Fatal("lost complete trailing line")
	}
}

func TestPiDiagnosticConcurrentSnapshot(t *testing.T) {
	a := New(agent.Config{}, WithDiagnostics())
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 100 {
				_, _ = io.WriteString(a.diagnostic, "sandbox-exec: denied\n")
				_ = a.Diagnostics(errors.New("startup failed"))
			}
		})
	}
	wg.Wait()
}

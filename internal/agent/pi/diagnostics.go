package pi

import (
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"

	"baton/internal/redact"
)

const diagnosticBytes = 8 * 1024
const diagnosticLines = 20

type Option func(*Adapter)

// WithDiagnostics opts into bounded, in-memory startup diagnostics. Production
// adapters discard stderr unless explicitly enabled; no raw log file is written.
func WithDiagnostics() Option {
	return func(a *Adapter) { a.diagnostic = &startupDiagnostics{} }
}

var (
	diagnosticANSI       = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	diagnosticCredential = regexp.MustCompile(`(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|authorization|password|cookie|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)`)
	diagnosticAuth       = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+`)
	diagnosticLongToken  = regexp.MustCompile(`[A-Za-z0-9_+-]{24,}`)
	diagnosticURL        = regexp.MustCompile(`(?i)(https?://)[^\s/@]+@`)
)

type startupDiagnostics struct {
	mu          sync.Mutex
	secrets     []string
	phase       string
	tail        []byte
	truncated   bool
	exited      bool
	exitCode    int
	exitError   string
	cleanupKill bool
}

func (d *startupDiagnostics) configure(env []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.secrets = nil
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if !ok || value == "" {
			continue
		}
		for _, sensitive := range []string{"KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH", "COOKIE"} {
			if strings.Contains(key, sensitive) {
				d.secrets = append(d.secrets, value)
				break
			}
		}
	}
	sort.Slice(d.secrets, func(i, j int) bool { return len(d.secrets[i]) > len(d.secrets[j]) })
}

func (d *startupDiagnostics) scrub(s string) string {
	s = diagnosticANSI.ReplaceAllString(s, "")
	for _, secret := range d.secrets {
		s = strings.ReplaceAll(s, secret, "[redacted]")
	}
	s = diagnosticAuth.ReplaceAllString(s, "$1 [redacted]")
	s = redact.Scrub(s)
	s = diagnosticCredential.ReplaceAllString(s, "$1[redacted]")
	s = diagnosticURL.ReplaceAllString(s, "$1[redacted]@")
	return diagnosticLongToken.ReplaceAllString(s, "[redacted]")
}

func (d *startupDiagnostics) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := len(p)
	if n > diagnosticBytes {
		d.tail = append(d.tail[:0], p[n-diagnosticBytes:]...)
		d.truncated = true
	} else {
		if excess := len(d.tail) + n - diagnosticBytes; excess > 0 {
			copy(d.tail, d.tail[excess:])
			d.tail = d.tail[:len(d.tail)-excess]
			d.truncated = true
		}
		d.tail = append(d.tail, p...)
	}
	return n, nil
}

func (a *Adapter) captureStderr(cmd *exec.Cmd, phase string) {
	cmd.Stderr = io.Discard
	if d := a.diagnostic; d != nil {
		d.configure(cmd.Env)
		d.mu.Lock()
		d.phase, d.tail, d.truncated, d.exited, d.exitError, d.cleanupKill = phase, nil, false, false, "", false
		d.mu.Unlock()
		cmd.Stderr = d
	}
}

func (d *startupDiagnostics) markCleanupKill() {
	d.mu.Lock()
	d.cleanupKill = true
	d.mu.Unlock()
}

func (a *Adapter) recordExit(cmd *exec.Cmd, err error) {
	if d := a.diagnostic; d != nil {
		d.mu.Lock()
		defer d.mu.Unlock()
		if state := cmd.ProcessState; state != nil {
			d.exited, d.exitCode = true, state.ExitCode()
		}
		if err != nil {
			d.exitError = err.Error()
		}
	}
}

// Diagnostics formats an error and the latest command's stderr tail only after
// credential redaction. It does not include stdout, RPC state or native history.
func (a *Adapter) Diagnostics(err error) string {
	d := a.diagnostic
	if d == nil {
		return "Pi diagnostics disabled"
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	tail := string(d.tail)
	if d.truncated {
		// Drop a partial first line so a truncated key cannot evade redaction.
		if i := strings.IndexByte(tail, '\n'); i >= 0 {
			tail = tail[i+1:]
		} else {
			tail = ""
		}
	}
	tail = strings.TrimSpace(d.scrub(tail))
	lines := strings.Split(tail, "\n")
	if len(lines) > diagnosticLines {
		tail = strings.Join(lines[len(lines)-diagnosticLines:], "\n")
	}
	code := "unavailable"
	if d.exited {
		code = fmt.Sprint(d.exitCode)
	}
	return fmt.Sprintf("error=%q phase=%s exited=%t exit_code=%s exit_error=%q cleanup_kill_requested=%t stderr_truncated=%t stderr_tail=%q", d.scrub(fmt.Sprint(err)), d.phase, d.exited, code, d.scrub(d.exitError), d.cleanupKill, d.truncated || len(lines) > diagnosticLines, tail)
}

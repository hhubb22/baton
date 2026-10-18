package relay_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/adapters"
	"baton/internal/adapters/codex"
	"baton/internal/session"
	"baton/internal/task"
)

// This test intentionally requires an independently authenticated, disposable
// CODEX_HOME. It never copies credentials from the user's normal home.
func TestRealCodex(t *testing.T) {
	if os.Getenv("BATON_REAL_CODEX") != "1" {
		t.Skip("requires explicit real-model opt-in; replay is not a substitute")
	}
	results := map[string]string{}
	for _, name := range []string{"启动", "输入", "结构化结果", "turn完成", "中止", "恢复", "历史", "委托"} {
		results[name] = "未验证"
	}
	defer func() {
		for _, name := range []string{"启动", "输入", "结构化结果", "turn完成", "中止", "恢复", "历史", "委托"} {
			t.Logf("%s=%s", name, results[name])
		}
	}()
	home, err := filepath.EvalSymlinks(os.Getenv("BATON_REAL_CODEX_HOME"))
	if err != nil {
		t.Fatal("set BATON_REAL_CODEX_HOME to an authenticated disposable temporary directory")
	}
	tmp, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(tmp, home)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || !strings.HasPrefix(filepath.Base(home), "baton-codex-real.") {
		t.Fatal("refusing non-isolated CODEX_HOME: use mktemp -d with prefix baton-codex-real.")
	}
	model := os.Getenv("BATON_CODEX_MODEL")
	if model == "" {
		t.Fatal("BATON_CODEX_MODEL must explicitly select the test model")
	}
	binary := os.Getenv("BATON_CODEX_BINARY")
	if binary == "" {
		binary = "codex"
	}
	binary, err = exec.LookPath(binary)
	if err != nil {
		t.Fatal("pinned codex CLI unavailable")
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CLI=%s platform=%s/%s model=%s; real model calls enabled", codex.Version, runtime.GOOS, runtime.GOARCH, model)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	work := t.TempDir()
	env := []string{"HOME=" + home, "USERPROFILE=" + home}
	for _, key := range []string{"PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	c := codex.Config{Binary: binary, Model: model, Directory: work, Home: home, SessionID: "real-fixture", StatePath: filepath.Join(work, "native.json"), Env: env}
	a := codex.New(c)
	defer a.Close()
	if _, err := a.Probe(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.CreateSession(ctx); err != nil {
		results["启动"] = "不支持"
		t.Fatal(err)
	}
	if err := a.StartTask(ctx, "real-start", `Only work in this temporary directory. Run a shell command that creates started.txt then waits for continue.txt (poll every second, at most 90 seconds). After it finishes return the requested JSON with status completed and summary equal to the token in the follow-up user message; use empty evidence/artifacts with honest empty reasons and null error.`); err != nil {
		results["启动"] = "不支持"
		t.Fatal(err)
	}
	results["启动"] = "支持"
	waitFile := func(name string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Minute)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(work, name)); err == nil {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal("real model timeout")
			case <-time.After(100 * time.Millisecond):
			}
		}
		t.Fatal("model did not reach controlled shell gate")
	}
	waitFile("started.txt")
	if err := a.SendInput(ctx, "real-steer", "The required summary token is baton-real-steer-ok."); err != nil {
		results["输入"] = "不支持"
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "continue.txt"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	nextTerminal := func(a *codex.Adapter) adapters.Event {
		t.Helper()
		for {
			select {
			case e := <-a.Events():
				if e.Settled || e.Uncertain {
					return e
				}
			case <-ctx.Done():
				t.Fatal("no real terminal event")
				return adapters.Event{}
			}
		}
	}
	e := nextTerminal(a)
	if !e.Settled || e.Uncertain {
		results["turn完成"] = "不支持"
		t.Fatal("real turn did not complete")
	}
	results["turn完成"] = "支持"
	result, err := task.ParseCandidate(e.Final)
	if err != nil || result.Status != task.StatusCompleted {
		results["结构化结果"] = "不支持"
		t.Fatal("model result failed Baton validation")
	}
	results["结构化结果"] = "支持"
	if result.Summary != "baton-real-steer-ok" {
		results["输入"] = "不支持"
		t.Fatal("steer was not reflected in real result")
	}
	results["输入"] = "支持"
	before := a.Snapshot()
	_ = a.Close()
	a = codex.New(c)
	defer a.Close()
	if err := a.Attach(ctx); err != nil {
		results["恢复"] = "不支持"
		t.Fatal(err)
	}
	if after := a.Snapshot(); after.ThreadID != before.ThreadID || after.TurnID != before.TurnID {
		t.Fatal("resume replaced original native identity")
	}
	if e := nextTerminal(a); !e.Settled {
		t.Fatal("resume did not prove original completion")
	}
	results["恢复"] = "支持"
	if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
		results["历史"] = "不支持"
		t.Fatal("real history missing")
	}
	results["历史"] = "支持"
	if err := a.StartTask(ctx, "real-interrupt", `Only work here. Run a shell command that creates interrupt-started.txt then sleeps for 90 seconds. Do not complete before the command ends.`); err != nil {
		t.Fatal(err)
	}
	waitFile("interrupt-started.txt")
	stopped, known, err := a.Interrupt(ctx)
	if err != nil || stopped || known {
		results["中止"] = "不支持"
		t.Fatal("interrupt failed or ACK was used as proof")
	}
	e = nextTerminal(a)
	if !e.Stopped || !e.Uncertain {
		results["中止"] = "不支持"
		t.Fatal("no interrupted turn fact; external side effects are not assumed undone")
	}
	results["中止"] = "支持"
	_ = a.Close()

	t.Run("Delegation", func(t *testing.T) {
		buildBins(t)
		binDir := t.TempDir()
		cli := filepath.Join(binDir, "baton")
		if runtime.GOOS == "windows" {
			cli += ".exe"
		}
		build := exec.CommandContext(ctx, "go", "build", "-o", cli, "./cmd/baton")
		build.Dir = filepath.Join("..", "..")
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build CLI: %v %s", err, out)
		}
		st := startPrepareStack(t, map[string]string{"BATON_TEST_EXECUTOR_LOG": "", "BATON_TEST_HOLD_START": "0", "BATON_CODEX_BINARY": binary, "BATON_CODEX_HOME": home, "BATON_CODEX_MODEL": model, "HOME": home, "USERPROFILE": home, "PATH": binDir + string(os.PathListSeparator) + os.Getenv("PATH")})
		if _, err := st.pool.Exec(ctx, `UPDATE nodes SET default_agent_type='codex' WHERE id=$1::uuid`, st.ident.NodeID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			st.batond.stop()
			dirs, _ := os.ReadDir(filepath.Join(st.dataDir, "sessions"))
			for _, d := range dirs {
				ep, err := session.Endpoint(st.dataDir, d.Name())
				if err != nil {
					continue
				}
				tokenPath, err := session.TokenPath(st.dataDir, d.Name())
				if err != nil {
					continue
				}
				token, err := os.ReadFile(tokenPath)
				if err != nil {
					continue
				}
				c, err := session.Dial(context.Background(), ep, strings.TrimSpace(string(token)))
				if err != nil {
					continue
				}
				if status, err := c.Status(); err == nil {
					stopWorker(status.PID)
				}
				_ = c.Close()
			}
		})
		parentDir, childDir := t.TempDir(), t.TempDir()
		request, _ := json.Marshal(map[string]any{"request_id": "real-child", "description": "Return a completed Baton JSON result with summary baton-real-child-ok; do not run tools or delegate.", "working_directory": childDir, "agent_type": "codex", "target_node_id": st.ident.NodeID})
		if err := os.WriteFile(filepath.Join(parentDir, "child.json"), request, 0600); err != nil {
			t.Fatal(err)
		}
		var source task.Record
		prompt := `Only operate in the two temporary working directories. Run baton delegate --request-file child.json --json once (reuse the same request on transport failure), extract task_id, run baton task wait ID --timeout 30s --json until terminal, then baton task result ID --json. Do not read BATON_CONTEXT_FILE yourself. After the child completes, return a completed Baton JSON result whose summary is exactly baton-real-parent-ok, empty evidence/artifacts with honest empty reasons, and null error. Never delegate again or claim success before querying the child result.`
		if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{"request_id": "real-parent", "description": prompt, "authorization_scope": fmt.Sprintf("Only temporary fixture directories %s and %s; delegate exactly one fixture task and query it using baton CLI.", parentDir, childDir), "working_directory": parentDir, "agent_type": "codex", "execution_timeout_seconds": 300}, st.csrf, &source); code != http.StatusOK {
			t.Fatal("real parent rejected", code)
		}
		deadline := time.Now().Add(5 * time.Minute)
		for time.Now().Before(deadline) {
			var status, summary string
			if err := st.pool.QueryRow(ctx, `SELECT status,COALESCE(summary,'') FROM tasks WHERE id=$1::uuid`, source.TaskID).Scan(&status, &summary); err != nil {
				t.Fatal(err)
			}
			if status == task.StatusCompleted {
				if summary != "baton-real-parent-ok" {
					t.Fatal("parent result mismatch")
				}
				break
			}
			if status == task.StatusFailed || status == task.StatusNeedsVerification || status == task.StatusCancelled {
				results["委托"] = "不支持"
				t.Fatal("real delegated flow did not complete", status)
			}
			select {
			case <-ctx.Done():
				t.Fatal("real delegate timeout")
			case <-time.After(300 * time.Millisecond):
			}
		}
		var children, completed int
		if err := st.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE status='completed' AND summary='baton-real-child-ok') FROM tasks WHERE parent_task_id=$1::uuid`, source.TaskID).Scan(&children, &completed); err != nil || children != 1 || completed != 1 {
			results["委托"] = "不支持"
			t.Fatal("expected exactly one completed child", err)
		}
		var parentDone bool
		if err := st.pool.QueryRow(ctx, `SELECT status='completed' FROM tasks WHERE id=$1::uuid`, source.TaskID).Scan(&parentDone); err != nil || !parentDone {
			t.Fatal("parent not complete", err)
		}
		results["委托"] = "支持"
	})
}

package gateway_test

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

	"baton/internal/agent/codex"
	"baton/internal/identity"
	"baton/internal/session"
	"baton/internal/task"
)

// TestRealCodex 使用独立认证的临时 CODEX_HOME；真实模型调用需显式开启。
func TestRealCodex(t *testing.T) {
	if os.Getenv("BATON_REAL_CODEX") != "1" {
		t.Skip("requires explicit real-model opt-in; replay is not a substitute")
	}
	results := map[string]string{}
	for _, name := range []string{"启动", "输入", "结构化结果", "turn完成", "中止", "恢复", "历史", "委托"} {
		results[name] = "未验证"
	}
	t.Cleanup(func() {
		for _, name := range []string{"启动", "输入", "结构化结果", "turn完成", "中止", "恢复", "历史", "委托"} {
			t.Logf("%s=%s", name, results[name])
		}
	})
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
	tool := realRecordingTool(t)
	for _, scenario := range append(append([]string(nil), realScenarios...), "delegation") {
		t.Run(scenario, func(t *testing.T) {
			if scenario == "result_free_text" {
				t.Skip("Codex StartTask 强制 outputSchema，无法按需录制自由文本；见 codex/testdata/replay/README.md")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			work := t.TempDir()
			work, err = filepath.EvalSymlinks(work)
			if err != nil {
				t.Fatal(err)
			}
			selectedModel := model
			if scenario == "provider_error" {
				selectedModel = "baton-nonexistent-model-ps174"
			}
			recording := newRealRecording(t, tool, "codex", codex.Version, selectedModel, binary,
				map[string]string{"<workspace>": work, "<home>": home})
			if scenario == "delegation" {
				runRealCodexDelegation(t, ctx, recording, home, model, results)
				return
			}
			c := realCodexConfig(t, home, work, recording.binary, selectedModel)
			if scenario == "symlinked_workspace" {
				c.Directory = realSymlinkedWorkspace(t, work)
				recording.bind(t, "<workspace_alias>", c.Directory)
			}
			a := codex.New(c)
			t.Cleanup(func() { _ = a.Close() })
			if _, err := a.Probe(ctx); err != nil {
				t.Fatal(err)
			}
			if scenario == "restore_missing" {
				realCodexRestoreMissing(t, ctx, a, c)
				return
			}
			if err := a.CreateSession(ctx); err != nil {
				if scenario == "provider_error" {
					return
				}
				results["启动"] = "不支持"
				t.Fatal(err)
			}
			switch scenario {
			case "simple", "symlinked_workspace", "interrupt_idle", "restore_load_only", "deliver_idle":
				if scenario == "restore_load_only" {
					// 恢复前完成一次 steer，验证带补充输入的原生历史。
					realCodexDeliverActive(t, ctx, a, work, results)
				} else {
					realCodexComplete(t, ctx, a, "real-simple", "baton-real-simple-ok", results)
				}
				switch scenario {
				case "interrupt_idle":
					stopped, known, err := a.Abort()
					if err != nil || !stopped || known {
						t.Fatal("空闲中止与已完成状态不符", err)
					}
				case "restore_load_only":
					realCodexRestore(t, ctx, a, c, results)
				case "deliver_idle":
					realCodexDeliver(t, ctx, a, "baton-idle-delivery", results)
				}
			case "deliver_active":
				realCodexDeliverActive(t, ctx, a, work, results)
			case "interrupt_mid_tool":
				realCodexInterruptTool(t, ctx, a, work, results)
			case "interrupt_before_turn_started":
				payload, _ := json.Marshal(map[string]any{"description": "Use no tools. Return a completed result with summary early-abort.", "generation": 1})
				if _, err := a.SubmitInput(ctx, string(payload)); err != nil {
					t.Fatal(err)
				}
				stopped, known, err := a.Abort()
				if known {
					t.Fatal("中止推定副作用已知")
				}
				if !stopped {
					if err != nil {
						t.Fatal(err)
					}
					waitRealStop(t, a)
				}
				if a.Snapshot().ThreadID == "" || a.Snapshot().TurnID == "" {
					t.Fatal("中止丢失原生身份")
				}
				if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
					t.Fatal("中止后的会话未保存", err)
				}
			case "provider_error":
				if err := a.StartTask(ctx, "real-provider-error", "Return a completed result."); err == nil {
					e := nextRealCodexTerminal(t, ctx, a)
					if !e.Uncertain || e.Final != "" {
						t.Fatal("不存在的模型被判为成功")
					}
				}
			}
		})
	}
}

func realCodexConfig(t *testing.T, home, work, binary, model string) codex.Config {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "USERPROFILE=" + home}
	for _, key := range []string{"PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return codex.Config{Binary: binary, Model: model, Directory: work, Home: home, SessionID: id, ExecutionID: id, StatePath: filepath.Join(work, "native.json"), Env: env}
}

func nextRealCodexTerminal(t *testing.T, ctx context.Context, a *codex.Adapter) codex.Event {
	t.Helper()
	for {
		select {
		case e := <-a.Events():
			if e.Final != "" && !e.Settled {
				t.Fatal("settled 之前输出最终结果")
			}
			if e.Settled || e.Uncertain {
				return e
			}
		case <-ctx.Done():
			t.Fatal("no real terminal event")
			return codex.Event{}
		}
	}
}

func realCodexComplete(t *testing.T, ctx context.Context, a *codex.Adapter, operation, summary string, results map[string]string) {
	t.Helper()
	if err := a.StartTask(ctx, operation, "Use no tools. Return a completed Baton JSON result with summary "+summary+"; use empty evidence/artifacts with honest empty reasons and null error."); err != nil {
		results["启动"] = "不支持"
		t.Fatal(err)
	}
	results["启动"] = "支持"
	e := nextRealCodexTerminal(t, ctx, a)
	checkRealCodexResult(t, e, summary, results)
	results["输入"] = "支持"
}

func checkRealCodexResult(t *testing.T, e codex.Event, summary string, results map[string]string) {
	t.Helper()
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
	if result.Summary != summary {
		results["输入"] = "不支持"
		t.Fatal("steer/input was not reflected in real result")
	}
}

func realCodexRestore(t *testing.T, ctx context.Context, a *codex.Adapter, c codex.Config, results map[string]string) {
	t.Helper()
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
	if e := nextRealCodexTerminal(t, ctx, a); !e.Settled {
		t.Fatal("resume did not prove original completion")
	}
	results["恢复"] = "支持"
	if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
		results["历史"] = "不支持"
		t.Fatal("real history missing")
	}
	results["历史"] = "支持"
}

func realCodexInterruptTool(t *testing.T, ctx context.Context, a *codex.Adapter, work string, results map[string]string) {
	t.Helper()
	if err := a.StartTask(ctx, "real-interrupt", `Only work here. Run a shell command that creates interrupt-started.txt then sleeps for 90 seconds. Do not complete before the command ends.`); err != nil {
		t.Fatal(err)
	}
	waitRealFile(t, ctx, filepath.Join(work, "interrupt-started.txt"))
	stopped, known, err := a.Abort()
	if err != nil || stopped || known {
		results["中止"] = "不支持"
		t.Fatal("interrupt failed or ACK was used as proof")
	}
	e := nextRealCodexTerminal(t, ctx, a)
	if !e.Stopped || !e.Uncertain {
		results["中止"] = "不支持"
		t.Fatal("no interrupted turn fact; external side effects are not assumed undone")
	}
	results["中止"] = "支持"
	_ = a.Close()

	if stopped, known := a.StopStatus(); !stopped || known {
		t.Fatal("StopObserver 未保存迟到停止事实")
	}
}

func realCodexDeliveryPayload(id, summary string) string {
	payload, _ := json.Marshal(map[string]string{"delivery_id": id, "description": "The required summary token is " + summary + ". Return a completed Baton JSON result with this summary after the current command finishes, empty evidence/artifacts with honest empty reasons and null error."})
	return string(payload)
}

func realCodexDeliver(t *testing.T, ctx context.Context, a *codex.Adapter, id string, results map[string]string) {
	t.Helper()
	if found, err := a.HistoryContains(id, false); err != nil || found {
		t.Fatal("交付前历史已含 delivery_id", err)
	}
	if _, err := a.DeliverResult(ctx, id, realCodexDeliveryPayload(id, "baton-real-delivery-ok")); err != nil {
		t.Fatal(err)
	}
	checkRealCodexResult(t, nextRealCodexTerminal(t, ctx, a), "baton-real-delivery-ok", results)
	checkRealCodexDeliveryHistory(t, a, id)
}

func checkRealCodexDeliveryHistory(t *testing.T, a *codex.Adapter, id string) {
	t.Helper()
	if found, err := a.HistoryContains(id, false); err != nil || !found {
		t.Fatal("交付未获原生历史确认", err)
	}
	if found, err := a.HistoryContains(id+"-other", false); err != nil || found {
		t.Fatal("原生历史错误匹配 delivery_id", err)
	}
}

func realCodexDeliverActive(t *testing.T, ctx context.Context, a *codex.Adapter, work string, results map[string]string) {
	t.Helper()
	if err := a.StartTask(ctx, "real-start", `Only work in this temporary directory. Run a shell command that creates started.txt then waits for continue.txt (poll every second, at most 90 seconds). After it finishes return the requested JSON with status completed and summary equal to the token in the follow-up user message; use empty evidence/artifacts with honest empty reasons and null error.`); err != nil {
		results["启动"] = "不支持"
		t.Fatal(err)
	}
	results["启动"] = "支持"
	waitRealFile(t, ctx, filepath.Join(work, "started.txt"))
	if found, err := a.HistoryContains("real-steer", false); err != nil || found {
		t.Fatal("交付前历史已含 delivery_id", err)
	}
	if _, err := a.DeliverResult(ctx, "real-steer", realCodexDeliveryPayload("real-steer", "baton-real-steer-ok")); err != nil {
		results["输入"] = "不支持"
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "continue.txt"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	checkRealCodexResult(t, nextRealCodexTerminal(t, ctx, a), "baton-real-steer-ok", results)
	checkRealCodexDeliveryHistory(t, a, "real-steer")
	results["输入"] = "支持"
}

func runRealCodexDelegation(t *testing.T, ctx context.Context, recording *realRecording, home, model string, results map[string]string) {
	t.Helper()
	binary := recording.binary

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
	parentDir, _ = filepath.EvalSymlinks(parentDir)
	childDir, _ = filepath.EvalSymlinks(childDir)
	recording.bind(t, "<workspace>", parentDir)
	recording.bind(t, "<child_workspace>", childDir)
	recording.bind(t, "<node_data>", st.dataDir)
	recording.bind(t, "<cli_bin>", binDir)
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
}

func realCodexRestoreMissing(t *testing.T, ctx context.Context, a *codex.Adapter, c codex.Config) {
	t.Helper()
	state := codex.State{Version: codex.Version, ThreadID: "00000000-0000-4000-8000-000000000174", SessionID: c.SessionID, Directory: c.Directory}
	writeRealJSON(t, c.StatePath, state)
	before, err := os.ReadFile(c.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Attach(ctx); err == nil {
		t.Fatal("缺失历史创建了新 thread")
	}
	after, err := os.ReadFile(c.StatePath)
	if err != nil || string(before) != string(after) || a.Snapshot().ThreadID != "" {
		t.Fatal("恢复失败替换了原生身份")
	}
}

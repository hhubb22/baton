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

	"baton/internal/agent"
	"baton/internal/agent/pi"
	"baton/internal/identity"
	"baton/internal/session"
	"baton/internal/store"
	"baton/internal/task"
)

// TestRealPi 仅在显式开启后运行，凭据来自环境变量，使用隔离的 Pi 目录。
func TestRealPi(t *testing.T) {
	if os.Getenv("BATON_REAL_PI") != "1" {
		t.Skip("set BATON_REAL_PI=1 explicitly; requires a model and isolated test PostgreSQL")
	}
	capabilities := map[string]string{"启动": "未验证", "输入": "未验证", "结构化结果": "未验证", "原生历史确认": "未验证", "中止": "未验证", "恢复": "未验证", "缺失历史拒绝": "未验证", "目录隔离": "未验证"}
	model := os.Getenv("BATON_PI_MODEL")
	if model == "" {
		model = "openai/gpt-6.1-sol"
	}
	for _, c := range model {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/+-", c) {
			t.Fatal("BATON_PI_MODEL must be a provider/model identifier")
		}
	}
	actualModel := "未验证"
	actualVersion := "未验证"
	t.Cleanup(func() {
		t.Logf("Pi version=%s expected_version=%s platform=%s/%s requested_model=%s actual_model=%s", actualVersion, pi.Version, runtime.GOOS, runtime.GOARCH, model, actualModel)
		for _, name := range []string{"启动", "输入", "结构化结果", "原生历史确认", "中止", "恢复", "缺失历史拒绝", "目录隔离"} {
			t.Logf("%s=%s", name, capabilities[name])
		}
	})
	if runtime.GOOS != "darwin" {
		t.Skip("real harness currently requires macOS sandbox-exec; no unsandboxed fallback")
	}
	keyPresent := false
	for _, key := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "ZAI_API_KEY"} {
		keyPresent = keyPresent || os.Getenv(key) != ""
	}
	if !keyPresent {
		t.Fatal("export the selected provider API key; existing login files are intentionally not read")
	}
	tool := realRecordingTool(t)
	bins := buildRealPiBins(t)
	for _, scenario := range append(append([]string(nil), realScenarios...), "restore_recall") {
		t.Run(scenario, func(t *testing.T) {
			if scenario == "deliver_active" || scenario == "deliver_idle" {
				t.Skip("子结果交付由既有录制回放覆盖")
			}
			selectedModel := model
			if scenario == "provider_error" {
				selectedModel = "baton-nonexistent-model-ps174"
				if provider, _, ok := strings.Cut(model, "/"); ok {
					selectedModel = provider + "/" + selectedModel
				}
			}
			f := startRealPiFixture(t, tool, selectedModel, bins[0], bins[1])
			capabilities["目录隔离"] = "支持"
			st, work := f.st, f.work
			switch scenario {
			case "simple", "restore_load_only", "restore_recall":
				_, sid := f.complete(t, capabilities)
				if scenario != "simple" {
					f.restore(t, sid, scenario == "restore_recall", capabilities)
				}
			case "interrupt_mid_tool":
				f.interruptMidTool(t, capabilities)
			case "restore_missing":
				// 建立本场景会话后，使用同一 ID 和不存在的历史目录恢复。
				missing := f.config(t)
				a := f.adapter(t, missing)
				_ = a.Close()
				missing.SessionDir = filepath.Join(f.root, "missing-native")
				missing.Restore = true
				a = pi.New(missing)
				defer a.Close()
				if err := a.Start(context.Background()); err != pi.ErrHistoryMissing {
					t.Fatal("missing history created an empty Session")
				}
				capabilities["缺失历史拒绝"] = "支持"

			case "result_free_text":
				rec := f.accept(t, "real-pi-free-text", "Use no tools. Reply with exactly baton-free-text, without JSON or Markdown.")
				waitRealPiFailure(t, st, rec.TaskID)
				var code string
				if err := st.pool.QueryRow(context.Background(), `SELECT error_code FROM tasks WHERE id=$1::uuid`, rec.TaskID).Scan(&code); err != nil || code != task.CodeResultFormat {
					t.Fatal("自由文本未按 result_format 拒绝", err)
				}
			case "provider_error":
				c := f.config(t)
				a := pi.New(c, pi.WithDiagnostics())
				defer a.Close()
				if err := a.Start(context.Background()); err == nil {
					_, err = a.SubmitInput(context.Background(), "Reply with a completed result.")
					if err == nil {
						out := waitRealPiOutput(t, a)
						if !out.Exited || !out.Uncertain || out.Final != "" {
							t.Fatal("不存在的模型被判为成功")
						}
					}
				}
			case "symlinked_workspace":
				c := f.config(t)
				c.Directory = realSymlinkedWorkspace(t, work)
				a := f.adapter(t, c)
				f.submit(t, a, realPiCompletedExample("symlink"))
				assertRealCompleted(t, waitRealPiOutput(t, a), "symlink")
			case "interrupt_idle", "interrupt_before_turn_started":
				c := f.config(t)
				a := f.adapter(t, c)
				f.submit(t, a, realPiCompletedExample("interrupt"))
				if scenario == "interrupt_idle" {
					assertRealCompleted(t, waitRealPiOutput(t, a), "interrupt")
				}
				stopped, known, err := a.Abort()
				if !stopped {
					waitRealStop(t, a)
					stopped, known = a.StopStatus()
				}
				if page, err := a.ReadHistory(context.Background(), ""); err != nil || !json.Valid(page.Data) {
					t.Fatal("中止后的会话未保存", err)
				}
				if !stopped || !known || (scenario == "interrupt_idle" && err != nil) {
					t.Fatal("无工具回合的中止缺少停止证据", err)
				}
			}
		})
	}
	// 版本与实际模型探针有独立场景，避免规范化时丢弃后续任务会话。
	t.Run("startup", func(t *testing.T) {
		f := startRealPiFixture(t, tool, model, bins[0], bins[1])
		c := f.config(t)
		c.Directory, c.SessionDir = filepath.Join(f.root, "probe"), filepath.Join(f.root, "probe", "native")
		a := f.adapter(t, c)
		actualModel, actualVersion = a.Model(), pi.Version
		if actualModel == "" {
			t.Fatal("Pi selected no model")
		}
		capabilities["启动"] = "支持"
	})
}

type realPiFixture struct {
	root, work, binary, model string
	st                        *prepareStack
}

func buildRealPiBins(t *testing.T) [2]string {
	t.Helper()
	var bins [2]string
	for i, name := range []string{"coordinator", "batond"} {
		bins[i] = filepath.Join(t.TempDir(), name)
		cmd := exec.Command("go", "build", "-o", bins[i], "./cmd/"+name)
		cmd.Dir = filepath.Join("..", "..")
		if raw, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", name, err, raw)
		}
	}
	return bins
}

func startRealPiFixture(t *testing.T, tool, model, coord, batond string) *realPiFixture {
	t.Helper()
	root, dataRoot := realPiDirectories(t)
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"bin", "home", "home/tmp", "work", "probe"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	bin := os.Getenv("BATON_PI_BIN")
	if bin == "" {
		bin = "pi"
	}
	bin, err = exec.LookPath(bin)
	if err != nil {
		t.Fatal("Pi binary unavailable")
	}
	bin, err = filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatal("Pi binary unavailable")
	}
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("Node.js unavailable")
	}
	nodeBin, err = filepath.EvalSymlinks(nodeBin)
	if err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(root, "pi.sb")
	wrapper := filepath.Join(root, "bin", "pi-isolated")
	writeRealPiWrapper(t, wrapper, profile, bin)
	recording := newRealRecording(t, tool, "pi", pi.Version, model, wrapper, map[string]string{"<fixture>": root, "<home>": filepath.Join(root, "home"), "<workspace>": filepath.Join(root, "work")})
	st := startPrepareStackWithBins(t, map[string]string{"BATON_AGENT_DRIVER": "native", "BATON_TEST_HOLD_START": "0", "BATON_PI_BIN": recording.binary, "BATON_PI_MODEL": model, "BATON_PI_HOME": filepath.Join(root, "home"), "PATH": filepath.Join(root, "bin") + string(os.PathListSeparator) + os.Getenv("PATH")}, coord, batond, dataRoot)
	t.Cleanup(func() {
		st.batond.stop()
		entries, _ := os.ReadDir(filepath.Join(st.dataDir, "sessions"))
		for _, entry := range entries {
			tokenPath, err := session.TokenPath(st.dataDir, entry.Name())
			if err != nil {
				continue
			}
			token, err := os.ReadFile(tokenPath)
			if err != nil {
				continue
			}
			endpoint, err := session.Endpoint(st.dataDir, entry.Name())
			if err != nil {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			c, err := session.Dial(ctx, endpoint, strings.TrimSpace(string(token)))
			if err == nil {
				status, err := c.Status()
				_ = c.Close()
				if err == nil && status.PID > 0 {
					_ = exec.Command("/bin/kill", "-TERM", "--", fmt.Sprintf("-%d", status.PID)).Run()
				}
			}
			cancel()
		}
	})
	physicalDataDir, err := filepath.EvalSymlinks(st.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	readDirs := []string{root, filepath.Join(physicalDataDir, "sessions"), filepath.Dir(nodeBin), piSandboxRuntimeDir(bin)}
	writeDirs := []string{filepath.Join(root, "home"), filepath.Join(root, "work"), filepath.Join(root, "probe"), filepath.Join(root, "missing-native"), filepath.Join(physicalDataDir, "sessions")}
	if err := os.WriteFile(profile, []byte(piSandboxPolicy(readDirs, writeDirs, filepath.Join(root, "ipc"))), 0o600); err != nil {
		t.Fatal(err)
	}
	recording.bind(t, "<node_data>", physicalDataDir)
	if physicalDataDir != st.dataDir {
		recording.bind(t, "<node_data_alias>", st.dataDir)
	}
	checkPiSandbox(t, profile, root)
	return &realPiFixture{root: root, work: filepath.Join(root, "work"), binary: recording.binary, model: model, st: st}
}

func (f *realPiFixture) accept(t *testing.T, request, description string) task.Record {
	st, work := f.st, f.work
	t.Helper()
	var rec task.Record
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{"request_id": request, "description": description, "authorization_scope": "Only operate in the isolated working_directory. Do not inspect or print credentials, context, environment variables or files outside it.", "working_directory": work, "execution_timeout_seconds": 300}, st.csrf, &rec); code != http.StatusOK {
		t.Fatalf("task acceptance: %d", code)
	}
	return rec
}

func (f *realPiFixture) complete(t *testing.T, capabilities map[string]string) (task.Record, string) {
	t.Helper()
	st := f.st
	finished := f.accept(t, "real-pi-complete", "Write exactly 'one\\n' to count.txt once. After the command finishes, your final reply must be ONLY this JSON object, without Markdown or prose: "+realPiCompletedExample("real-pi-complete")+" Do not invoke any other tool or inspect any other file.")
	waitRealPiStatus(t, st, finished.TaskID, task.StatusCompleted, capabilities)
	capabilities["输入"], capabilities["结构化结果"] = "支持", "支持"
	sid := sessionOf(t, st, finished.TaskID)
	return finished, sid
}

func (f *realPiFixture) restore(t *testing.T, sid string, recallContext bool, capabilities map[string]string) {
	t.Helper()
	st, work := f.st, f.work
	// batond 重启后必须重连原 Worker，并保留仅一次的输入副作用。
	worker := workerStatus(t, st.dataDir, sid)
	st.batond.stop()
	st.batond = startCmd(t, st.batondBin, st.batondArgs, st.batondEnv)
	waitLog(t, st.batond, "event=synced")
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	if got := workerStatus(t, st.dataDir, sid); got.PID != worker.PID {
		t.Fatal("daemon restart replaced the original Worker")
	}
	config := agent.Config{Binary: f.binary, Model: f.model, Directory: work, SessionDir: filepath.Join(st.dataDir, "sessions", sid, "native"), SessionID: sid, Restore: true, Env: pi.IsolatedEnv(filepath.Join(f.root, "home"))}
	restored := pi.New(config, pi.WithDiagnostics())
	t.Cleanup(func() { _ = restored.Close() })
	if err := restored.Start(context.Background()); err != nil {
		capabilities["恢复"] = "不支持"
		t.Fatal(restored.Diagnostics(err))
	}
	if out := restored.Drain(); len(out) != 0 {
		t.Fatal("restore unexpectedly replayed a model turn")
	}
	if !recallContext {
		assertRealOnceOnlyFile(t, work)
		capabilities["恢复"] = "支持"
		return
	}
	// 显式的新回合验证原上下文仍在；它不重放原任务。
	recall, _ := json.Marshal(map[string]string{"description": "Without tools, recall the previous task's requested summary. This is a new recall-only task; reply ONLY with this JSON object, without Markdown or prose: " + realPiCompletedExample("real-pi-complete")})
	if _, err := restored.SubmitInput(context.Background(), string(recall)); err != nil {
		t.Fatal(err)
	}
	out := waitRealPiOutput(t, restored)
	candidate, err := task.ParseCandidate(out.Final)
	if err != nil || candidate.Summary != "real-pi-complete" || !out.Exited {
		t.Fatal("restored model did not recall old context")
	}
	_ = restored.Close()
	assertRealOnceOnlyFile(t, work)
	capabilities["恢复"] = "支持"
}

func (f *realPiFixture) interruptMidTool(t *testing.T, capabilities map[string]string) {
	t.Helper()
	st, work := f.st, f.work
	abortTask := f.accept(t, "real-pi-abort", "Use bash to execute exactly: printf started > abort-started; sleep 15; printf late > abort-finished. Do not finish early. Only after the command finishes, reply with this JSON object without Markdown or prose: "+realPiCompletedExample("real-pi-abort"))
	deadline := time.Now().Add(3 * time.Minute)
	for {
		if _, err := os.Stat(filepath.Join(work, "abort-started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("abort test never reached tool execution")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(work, "abort-finished")); !os.IsNotExist(err) {
		t.Fatal("abort test tool already finished before cancellation")
	}
	abortRequested := time.Now()
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+abortTask.TaskID+"/cancel", map[string]any{}, st.csrf, nil); code != http.StatusOK {
		t.Fatal("cancel request failed")
	}
	// Pi 1.3.0 会等待当前工具结束；给工具与停止事实的中心上报留出时间。
	deadline = time.Now().Add(90 * time.Second)
	var aborted task.Record
	for {
		var err error
		aborted, err = readRealPiStopStatus(st, abortTask.TaskID)
		if err != nil {
			t.Fatalf("abort status unavailable: %s", pi.ScrubDiagnosticText(err.Error(), os.Environ()))
		}
		if aborted.StopConfirmedAt != nil {
			break
		}
		if time.Now().After(deadline) {
			capabilities["中止"] = "不支持"
			t.Fatalf("abort did not settle within 90s: status=%q acknowledged=%t confirmed=%t outcome_known=%t", aborted.Status, aborted.StopAcknowledgedAt != nil, aborted.StopConfirmedAt != nil, aborted.StopOutcomeKnown)
		}
		time.Sleep(100 * time.Millisecond)
	}
	abortSID := sessionOf(t, st, abortTask.TaskID)
	_ = workerStatus(t, st.dataDir, abortSID)

	if aborted.Status != task.StatusNeedsVerification || aborted.StopAcknowledgedAt == nil || aborted.StopOutcomeKnown {
		t.Fatal("tool side effects were incorrectly declared known")
	}
	if info, err := os.Stat(filepath.Join(work, "abort-finished")); err == nil {
		if !info.ModTime().After(abortRequested) {
			t.Fatal("trailing write predates the cancellation request")
		}
		t.Log("中止请求后仍观察到工具写入；Agent 已停止，操作结果未知，任务保持待核实")
	} else if os.IsNotExist(err) {
		t.Log("本次未观察到后续写入；不据此推断工具可被打断或外部副作用已知")
	} else {
		t.Fatal("abort side-effect fixture unavailable")
	}
	capabilities["中止"] = "支持（等当前工具结束后生效，不能中断运行中的工具）"
}

func (f *realPiFixture) config(t *testing.T) agent.Config {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return agent.Config{Binary: f.binary, Model: f.model, Directory: f.work, SessionDir: filepath.Join(f.work, "native"), SessionID: id, Env: pi.IsolatedEnv(filepath.Join(f.root, "home"))}
}

func (f *realPiFixture) adapter(t *testing.T, c agent.Config) *pi.Adapter {
	t.Helper()
	a := pi.New(c, pi.WithDiagnostics())
	t.Cleanup(func() { _ = a.Close() })
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(a.Diagnostics(err))
	}
	return a
}

func (f *realPiFixture) submit(t *testing.T, a *pi.Adapter, result string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"description": "Use no tools. Reply ONLY with this JSON object: " + result})
	if _, err := a.SubmitInput(context.Background(), string(payload)); err != nil {
		t.Fatal(err)
	}
}

func readRealPiStopStatus(st *prepareStack, id string) (task.Record, error) {
	return store.New(st.pool).GetTask(context.Background(), st.employeeID, id)
}

func TestRealPiStopStatusRead(t *testing.T) {
	st := startPrepareStack(t, map[string]string{"BATON_TEST_HOLD_START": "0", "BATON_TEST_ABORT_SCRIPT": "unknown"})
	created := acceptTask(t, st, "real-pi-stop-status-read")
	waitTaskStatus(t, st, created.TaskID, task.StatusRunning)
	taskWorker(t, st, created.TaskID)
	before, err := readRealPiStopStatus(st, created.TaskID)
	if err != nil {
		t.Fatalf("read running task: %v", err)
	}
	if before.Status != task.StatusRunning || before.StopAcknowledgedAt != nil || before.StopConfirmedAt != nil || before.StopOutcomeKnown {
		t.Fatal("task without stop evidence invented a stop")
	}
	if code := postJSON(t, st.client, st.base+"/api/v1/tasks/"+created.TaskID+"/cancel", map[string]any{}, st.csrf, nil); code != http.StatusOK {
		t.Fatalf("cancel fixture: %d", code)
	}
	waitStopEvidence(t, st, created.TaskID)
	var stops int
	if err := st.pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM execution_stops x JOIN executions e ON e.id=x.execution_id WHERE e.task_id=$1::uuid`, created.TaskID).Scan(&stops); err != nil || stops != 1 {
		t.Fatalf("execution_stops fixture missing: count=%d err=%v", stops, err)
	}
	got, err := readRealPiStopStatus(st, created.TaskID)
	if err != nil {
		t.Fatalf("read task with execution_stops evidence: %v", err)
	}
	if got.Status != task.StatusNeedsVerification || got.StopAcknowledgedAt == nil || got.StopConfirmedAt == nil || got.StopOutcomeKnown {
		t.Fatal("derived stop evidence lost or unknown outcome declared known")
	}
	if _, err := readRealPiStopStatus(st, "invalid-id"); err != store.ErrNotVisible {
		t.Fatalf("task read error was swallowed: %v", err)
	}
}

func waitRealPiStatus(t *testing.T, st *prepareStack, id, want string, capabilities map[string]string) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Minute)
	for time.Now().Before(deadline) {
		var got realPiCenterStatus
		if err := st.pool.QueryRow(context.Background(), `
			SELECT status, COALESCE(error_code, ''), COALESCE(error_message, ''),
			       COALESCE(summary, ''), COALESCE(evidence_empty_reason, '')
			FROM tasks WHERE id=$1::uuid`, id).Scan(&got.Status, &got.ErrorCode, &got.ErrorMessage, &got.Summary, &got.EvidenceEmptyReason); err != nil {
			t.Fatal("task status unavailable")
		}
		if got.Status == want {
			return
		}
		if got.Status == task.StatusFailed || got.Status == task.StatusNeedsVerification {
			if got.ErrorCode == task.CodeResultFormat {
				capabilities["结构化结果"] = "不支持"
				t.Fatalf("real Pi task ended: %s; 本次模型未交回约定 JSON，结构化结果=不支持（检查所选廉价模型的输出）", formatRealPiCenterStatus(got))
			}
			t.Fatalf("real Pi task ended: %s; inspect isolated history locally, do not publish raw history", formatRealPiCenterStatus(got))
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("real Pi task timed out; capability remains unverified")
}

type realPiCenterStatus struct {
	Status              string
	ErrorCode           string
	ErrorMessage        string
	Summary             string
	EvidenceEmptyReason string
}

func formatRealPiCenterStatus(got realPiCenterStatus) string {
	env := os.Environ()
	scrub := func(s string) string { return pi.ScrubDiagnosticText(s, env) }
	return fmt.Sprintf("status=%q error_code=%q error_message=%q summary=%q evidence_empty_reason=%q",
		scrub(got.Status), scrub(got.ErrorCode), scrub(got.ErrorMessage), scrub(got.Summary), scrub(got.EvidenceEmptyReason))
}

func realPiCompletedExample(summary string) string {
	return fmt.Sprintf(`{"status":"completed","summary":%q,"evidence":[],"evidence_empty_reason":"本次无结构化证据引用","artifacts":[],"artifacts_empty_reason":"本次无结构化产物引用","error":null}`, summary)
}

func realPiDirectories(t *testing.T) (root, dataRoot string) {
	t.Helper()
	if os.Getenv("BATON_REAL_PI_KEEP") != "1" {
		return t.TempDir(), ""
	}
	base, err := os.MkdirTemp("", "baton-real-pi-")
	if err != nil {
		t.Fatal(err)
	}
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatal(err)
	}
	root, dataRoot = filepath.Join(base, "isolated"), filepath.Join(base, "stack")
	for _, dir := range []string{root, dataRoot} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("BATON_REAL_PI_KEEP=1 isolated_directory=%q native_history_under=%q; contains credentials and history: keep private, remove after inspection", base, filepath.Join(dataRoot, "node", "sessions"))
	return root, dataRoot
}

func TestRealPiResultDiagnostics(t *testing.T) {
	t.Setenv("GOOGLE_CLOUD_API_KEY", "tiny-fixture-key")
	fields := realPiCenterStatus{
		Status: task.StatusFailed, ErrorCode: task.CodeResultFormat,
		ErrorMessage: "invalid JSON: GOOGLE_CLOUD_API_KEY=tiny-fixture-key",
		Summary:      "执行器没有交回可校验的结构化结果", EvidenceEmptyReason: "没有结构化证据",
	}
	got := formatRealPiCenterStatus(fields)
	for _, field := range []string{`status="failed"`, `error_code="result_format"`, `error_message=`,
		`summary="执行器没有交回可校验的结构化结果"`, `evidence_empty_reason="没有结构化证据"`, "[redacted]"} {
		if !strings.Contains(got, field) {
			t.Fatalf("missing %q in center diagnostic: %s", field, got)
		}
	}
	if strings.Contains(got, "tiny-fixture-key") {
		t.Fatal("provider credential leaked")
	}
	candidate, err := task.ParseCandidate(realPiCompletedExample("real-pi-complete"))
	if err != nil || candidate.Status != task.StatusCompleted || candidate.Summary != "real-pi-complete" {
		t.Fatalf("example is not an accepted result: %+v %v", candidate, err)
	}
}

func TestRealPiDirectoryRetention(t *testing.T) {
	var removed string
	t.Run("default", func(t *testing.T) {
		t.Setenv("BATON_REAL_PI_KEEP", "0")
		root, dataRoot := realPiDirectories(t)
		if dataRoot != "" {
			t.Fatalf("default unexpectedly kept stack directory: %q", dataRoot)
		}
		removed = root
	})
	if _, err := os.Stat(removed); !os.IsNotExist(err) {
		t.Fatalf("default isolation root was not removed: %v", err)
	}
	var base string
	t.Run("explicit_keep", func(t *testing.T) {
		t.Setenv("BATON_REAL_PI_KEEP", "1")
		root, dataRoot := realPiDirectories(t)
		base = filepath.Dir(root)
		if filepath.Dir(dataRoot) != base || root == dataRoot {
			t.Fatalf("isolated and node data directories must be siblings: %q %q", root, dataRoot)
		}
		for _, dir := range []string{root, dataRoot} {
			if err := os.WriteFile(filepath.Join(dir, "retention-fixture"), []byte("fixture"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	})
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	for _, dir := range []string{"isolated", "stack"} {
		if raw, err := os.ReadFile(filepath.Join(base, dir, "retention-fixture")); err != nil || string(raw) != "fixture" {
			t.Fatalf("retained isolation tree missing %s: %q %v", dir, raw, err)
		}
	}
}

func waitRealPiOutput(t *testing.T, a *pi.Adapter) agent.Output {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		if out := a.Drain(); len(out) > 0 {
			return out[len(out)-1]
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("real Pi did not settle")
	return agent.Output{}
}

func waitRealPiFailure(t *testing.T, st *prepareStack, id string) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Minute)
	for time.Now().Before(deadline) {
		var status string
		if err := st.pool.QueryRow(context.Background(), `SELECT status FROM tasks WHERE id=$1::uuid`, id).Scan(&status); err != nil {
			t.Fatal("任务状态不可用")
		}
		if status == task.StatusFailed {
			return
		}
		if status == task.StatusCompleted || status == task.StatusNeedsVerification || status == task.StatusCancelled {
			t.Fatal("自由文本任务没有按失败结束", status)
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("自由文本任务超时")
}

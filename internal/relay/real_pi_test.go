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

	"baton/internal/agent"
	"baton/internal/agent/pi"
	"baton/internal/identity"
	"baton/internal/session"
	"baton/internal/task"
)

// TestRealPi is deliberately excluded unless explicitly requested. It never
// opens the caller's Pi auth/config directories; supply a provider key via env.
func TestRealPi(t *testing.T) {
	if os.Getenv("BATON_REAL_PI") != "1" {
		t.Skip("set BATON_REAL_PI=1 explicitly; requires a model and isolated test PostgreSQL")
	}
	capabilities := map[string]string{"启动": "未验证", "输入": "未验证", "结构化结果": "未验证", "委托": "未验证", "原生历史确认": "未验证", "中止": "未验证", "恢复": "未验证", "缺失历史拒绝": "未验证", "目录隔离": "未验证"}
	model := os.Getenv("BATON_PI_MODEL")
	for _, c := range model {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/+-", c) {
			t.Fatal("BATON_PI_MODEL must be a provider/model identifier")
		}
	}
	actualModel := "未验证"
	actualVersion := "未验证"
	t.Cleanup(func() {
		t.Logf("Pi version=%s expected_version=%s platform=%s/%s requested_model=%s actual_model=%s", actualVersion, pi.Version, runtime.GOOS, runtime.GOARCH, model, actualModel)
		for _, name := range []string{"启动", "输入", "结构化结果", "委托", "原生历史确认", "中止", "恢复", "缺失历史拒绝", "目录隔离"} {
			t.Logf("%s=%s", name, capabilities[name])
		}
	})
	if runtime.GOOS != "darwin" {
		t.Skip("real harness currently requires macOS sandbox-exec; no unsandboxed fallback")
	}
	if model == "" {
		t.Fatal("BATON_PI_MODEL is required; select an inexpensive provider/model")
	}
	keyPresent := false
	for _, key := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "ZAI_API_KEY"} {
		keyPresent = keyPresent || os.Getenv(key) != ""
	}
	if !keyPresent {
		t.Fatal("export the selected provider API key; existing login files are intentionally not read")
	}
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
	build := func(name string) string {
		t.Helper()
		out := filepath.Join(root, "bin", name)
		cmd := exec.Command("go", "build", "-o", out, "./cmd/"+name)
		cmd.Dir = filepath.Join("..", "..")
		if raw, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", name, err, raw)
		}
		return out
	}
	coord, relay, batond := build("coordinator"), build("relay"), build("batond")
	cli := build("baton")
	profile := filepath.Join(root, "pi.sb")
	wrapper := filepath.Join(root, "bin", "pi-isolated")
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\nexec /usr/bin/sandbox-exec -f "+quote(profile)+" "+quote(bin)+" \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	st := startPrepareStackWithBins(t, map[string]string{"BATON_AGENT_DRIVER": "native", "BATON_TEST_HOLD_START": "0", "BATON_PI_BIN": wrapper, "BATON_PI_MODEL": model, "BATON_PI_HOME": filepath.Join(root, "home"), "PATH": filepath.Join(root, "bin") + string(os.PathListSeparator) + os.Getenv("PATH")}, coord, relay, batond, dataRoot)
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
	endpoint, err := session.AgentEndpoint(st.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	physicalDataDir, err := filepath.EvalSymlinks(st.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	readDirs := []string{root, filepath.Join(physicalDataDir, "sessions"), filepath.Dir(nodeBin), piSandboxRuntimeDir(bin)}
	writeDirs := []string{filepath.Join(root, "home"), filepath.Join(root, "work"), filepath.Join(root, "probe"), filepath.Join(root, "missing-native"), filepath.Join(physicalDataDir, "sessions")}
	if err := os.WriteFile(profile, []byte(piSandboxPolicy(readDirs, writeDirs, endpoint)), 0o600); err != nil {
		t.Fatal(err)
	}
	checkPiSandbox(t, profile, root)
	capabilities["目录隔离"] = "支持"
	probeID, _ := identity.NewUUID()
	probe := pi.New(agent.Config{Binary: wrapper, Model: model, Directory: filepath.Join(root, "probe"), SessionDir: filepath.Join(root, "probe", "native"), SessionID: probeID, Env: pi.IsolatedEnv(filepath.Join(root, "home"))}, pi.WithDiagnostics())
	if err := probe.Start(context.Background()); err != nil {
		t.Fatal(probe.Diagnostics(err))
	}
	actualModel = probe.Model()
	actualVersion = pi.Version
	_ = probe.Close()
	if actualModel == "" {
		t.Fatal("Pi selected no model")
	}
	capabilities["启动"] = "支持"
	work := filepath.Join(root, "work")
	accept := func(request, description string) task.Record {
		t.Helper()
		var rec task.Record
		if code := postJSON(t, st.client, st.base+"/api/v1/tasks", map[string]any{"request_id": request, "description": description, "authorization_scope": "Only operate in the isolated working_directory. Do not inspect or print credentials, context, environment variables or files outside it. Use the Baton CLI only for delegation.", "working_directory": work, "execution_timeout_seconds": 300}, st.csrf, &rec); code != http.StatusOK {
			t.Fatalf("task acceptance: %d", code)
		}
		return rec
	}
	finished := accept("real-pi-complete", "Write exactly 'one\\n' to count.txt once. After the command finishes, your final reply must be ONLY this JSON object, without Markdown or prose: "+realPiCompletedExample("real-pi-complete")+" Do not invoke any other tool or inspect any other file.")
	waitRealPiStatus(t, st, finished.TaskID, task.StatusCompleted, capabilities)
	capabilities["输入"], capabilities["结构化结果"] = "支持", "支持"
	sid := sessionOf(t, st, finished.TaskID)
	worker := workerStatus(t, st.dataDir, sid)
	t.Cleanup(func() { stopWorker(worker.PID) })
	// A surviving Worker reconnect must not replay the input on daemon restart.
	st.batond.stop()
	st.batond = startCmd(t, st.batondBin, st.batondArgs, st.batondEnv)
	waitLog(t, st.batond, "event=synced")
	waitNode(t, st.client, st.base, st.ident.NodeID, true, true, true)
	if got := workerStatus(t, st.dataDir, sid); got.PID != worker.PID {
		t.Fatal("daemon restart replaced the original Worker")
	}
	config := agent.Config{Binary: wrapper, Model: model, Directory: work, SessionDir: filepath.Join(st.dataDir, "sessions", sid, "native"), SessionID: sid, Restore: true, Env: pi.IsolatedEnv(filepath.Join(root, "home"))}
	restored := pi.New(config, pi.WithDiagnostics())
	t.Cleanup(func() { _ = restored.Close() })
	if err := restored.Start(context.Background()); err != nil {
		capabilities["恢复"] = "不支持"
		t.Fatal(restored.Diagnostics(err))
	}
	if out := restored.Drain(); len(out) != 0 {
		t.Fatal("restore unexpectedly replayed a model turn")
	}
	// Ask a new, explicit turn to recall old context; do not replay the task.
	recall, _ := json.Marshal(map[string]string{"description": "Without tools, recall the previous task's requested summary. This is a new recall-only task; reply ONLY with this JSON object, without Markdown or prose: " + realPiCompletedExample("real-pi-complete")})
	if _, err := restored.SubmitInput(context.Background(), string(recall)); err != nil {
		t.Fatal(err)
	}
	out := waitRealPiOutput(t, restored)
	var candidate task.Candidate
	candidate, err = task.ParseCandidate(out.Final)
	if err != nil || candidate.Summary != "real-pi-complete" || !out.Exited {
		t.Fatal("restored model did not recall old context")
	}
	_ = restored.Close()
	raw, err := os.ReadFile(filepath.Join(work, "count.txt"))
	if err != nil || string(raw) != "one\n" {
		t.Fatal("restore changed the once-only fixture")
	}
	capabilities["恢复"] = "支持"
	missing := config
	missing.SessionDir = filepath.Join(root, "missing-native")
	if err := pi.New(missing).Start(context.Background()); err != pi.ErrHistoryMissing {
		t.Fatal("missing history created an empty Session")
	}
	capabilities["缺失历史拒绝"] = "支持"
	// Leave the parent idle waiting for a real child. BATON_CONTEXT_FILE is only
	// consumed by the CLI, never opened by the model or included in its prompt.
	childRequest := filepath.Join(work, "delegate.json")
	request := map[string]any{"request_id": "real-pi-child", "description": "Use no tools. Reply ONLY with this JSON object, without Markdown or prose: " + realPiCompletedExample("real-pi-child"), "target_node_id": st.ident.NodeID, "agent_type": "pi", "working_directory": work}
	raw, _ = json.Marshal(request)
	if err := os.WriteFile(childRequest, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	parent := accept("real-pi-parent", fmt.Sprintf("Run exactly %s delegate --request-file %s --json using bash. Do not read the context file, environment or credentials. Then return exactly {\"baton_waiting_for_children\":true}. When Baton delivers the child result, reply ONLY with %s without Markdown or prose; do not delegate a second time.", quote(cli), quote(childRequest), realPiCompletedExample("real-pi-parent")))
	waitRealPiStatus(t, st, parent.TaskID, task.StatusCompleted, capabilities)
	parentSID := sessionOf(t, st, parent.TaskID)
	parentWorker := workerStatus(t, st.dataDir, parentSID)
	t.Cleanup(func() { stopWorker(parentWorker.PID) })
	var childID, deliveryStatus string
	if err := st.pool.QueryRow(context.Background(), `SELECT e.task_id::text, c.status FROM child_deliveries c JOIN executions e ON e.id=c.child_execution_id WHERE c.source_execution_id = $1::uuid`, parentWorker.ExecutionID).Scan(&childID, &deliveryStatus); err != nil || deliveryStatus != "delivered" {
		t.Fatal("child result missing native-history confirmation")
	}
	childSID := sessionOf(t, st, childID)
	childWorker := workerStatus(t, st.dataDir, childSID)
	t.Cleanup(func() { stopWorker(childWorker.PID) })
	capabilities["委托"], capabilities["原生历史确认"] = "支持", "支持"
	// Wait for a deterministic tool-start fixture before cancellation, not just
	// a running row that can precede the model's first tool call.
	abortTask := accept("real-pi-abort", "Use bash to execute exactly: printf started > abort-started; sleep 15; printf late > abort-finished. Do not finish early. Only after the command finishes, reply with this JSON object without Markdown or prose: "+realPiCompletedExample("real-pi-abort"))
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
	// Pi 1.3.0 may finish its current tool before settling. Allow the tool's
	// remaining 15 seconds plus settlement and central report delivery.
	deadline = time.Now().Add(90 * time.Second)
	var status string
	var acknowledged, confirmed, outcomeKnown bool
	for {
		if err := st.pool.QueryRow(context.Background(), `SELECT status, stop_acknowledged_at IS NOT NULL,
		 stop_confirmed_at IS NOT NULL, stop_outcome_known FROM tasks WHERE id = $1::uuid`, abortTask.TaskID).
			Scan(&status, &acknowledged, &confirmed, &outcomeKnown); err != nil {
			t.Fatal("abort status unavailable")
		}
		if confirmed {
			break
		}
		if time.Now().After(deadline) {
			capabilities["中止"] = "不支持"
			t.Fatalf("abort did not settle within 90s: status=%q acknowledged=%t confirmed=%t outcome_known=%t", status, acknowledged, confirmed, outcomeKnown)
		}
		time.Sleep(100 * time.Millisecond)
	}
	abortSID := sessionOf(t, st, abortTask.TaskID)
	abortWorker := workerStatus(t, st.dataDir, abortSID)
	t.Cleanup(func() { stopWorker(abortWorker.PID) })
	if status != task.StatusNeedsVerification || !acknowledged || outcomeKnown {
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
				t.Fatalf("real Pi task ended: %s; 本次模型未交回约定 JSON，结构化结果=不支持（可用更强模型复验）", formatRealPiCenterStatus(got))
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

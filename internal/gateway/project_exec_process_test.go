package gateway_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
	"baton/internal/store"
)

type projectExecProbe struct {
	*projectRuntimeProbe
	project projectagent.Project
	runID   string
	seq     int64
	root    string
}

func startProjectExecStack(t *testing.T) *projectExecProbe {
	t.Helper()
	dir := t.TempDir()
	installProjectRuntime(t, dir)
	p := &projectRuntimeProbe{commands: filepath.Join(dir, "commands.jsonl"), log: filepath.Join(dir, "runtime.jsonl")}
	if err := os.WriteFile(p.commands, nil, 0600); err != nil {
		t.Fatal(err)
	}
	p.stack = startProjectStack(t, map[string]string{
		"PATH":                                dir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"BATON_TEST_PROJECT_RUNTIME_COMMANDS": p.commands,
		"BATON_TEST_PROJECT_RUNTIME_LOG":      p.log,
	})
	waitRuntimeReport(t, p.stack, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime != nil })
	rawRoot := t.TempDir()
	realRoot, err := filepath.EvalSymlinks(rawRoot)
	if err != nil {
		t.Fatal(err)
	}
	e := &projectExecProbe{projectRuntimeProbe: p, root: realRoot}
	t.Cleanup(func() { _ = os.WriteFile(filepath.Join(e.root, "release"), nil, 0600) })
	e.cli(t, "files", "add", "--data-dir", p.stack.dataDir, "--id", "exec-root", "--path", e.root)
	e.enable(t, true)
	e.project = createRuntimeProject(t, p)
	messageRuntimeProject(t, p, e.project, "exec-input")
	e.runID, _ = waitProjectRun(t, p, e.project, "")
	var claim projectagent.Claim
	if r := p.call(t, e.runID, "exec-claim", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, &claim); !r.OK || claim.Event == nil {
		t.Fatal("领取初始输入", r)
	}
	e.seq = claim.Event.Seq
	return e
}

func (e *projectExecProbe) cli(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command(e.stack.batondBin, args...).CombinedOutput(); err != nil {
		t.Fatalf("节点配置：%v %s", err, out)
	}
}

func (e *projectExecProbe) enable(t *testing.T, enabled bool) {
	t.Helper()
	shell := "sh"
	if runtime.GOOS == "windows" {
		shell = "pwsh"
	}
	e.cli(t, "project-exec", "--data-dir", e.stack.dataDir, fmt.Sprintf("--enabled=%t", enabled), "--shell", shell)
	waitRuntimeReport(t, e.stack, func(r protocol.RuntimeReport) bool { return r.Exec.Enabled == enabled && len(r.Roots) == 1 })
}

func (e *projectExecProbe) save(t *testing.T, id, command string, wait int, timeout ...int) protocol.ProjectRuntimeRequest {
	t.Helper()
	timeoutSeconds := 60
	if len(timeout) != 0 {
		timeoutSeconds = timeout[0]
	}
	args := map[string]any{"node_id": e.stack.ident.NodeID, "command": command, "working_directory": e.root, "wait_seconds": wait, "timeout_seconds": timeoutSeconds}
	var saved projectagent.Event
	if r := e.call(t, e.runID, id+"-save", assistantToolRequest(id, "nodes.exec", args, e.seq), &saved); !r.OK {
		t.Fatal(r)
	}
	e.seq = saved.Seq
	return toolProcessRequest(id, "nodes.exec", args, e.seq)
}

func (e *projectExecProbe) start(t *testing.T, id, command string, wait int, timeout ...int) (string, protocol.ProjectRuntimeRequest) {
	t.Helper()
	req := e.save(t, id, command, wait, timeout...)
	var pending struct {
		Pending  bool   `json:"pending"`
		ThreadID string `json:"thread_id"`
	}
	if r := e.call(t, e.runID, id+"-call", req, &pending); !r.OK || !pending.Pending || pending.ThreadID == "" {
		t.Fatalf("命令没有返回 pending：%+v %+v", r, pending)
	}
	return pending.ThreadID, req
}

func (e *projectExecProbe) wait(t *testing.T, id string, finish bool) projectagent.Event {
	t.Helper()
	req := protocol.ProjectRuntimeRequest{Operation: "wait_tool", ToolCallID: id, LastSeq: e.seq}
	if finish {
		req.Payload = json.RawMessage(`{"finish_wait":true}`)
	}
	deadline := time.Now().Add(20 * time.Second)
	for attempt := 0; time.Now().Before(deadline); attempt++ {
		var data struct {
			Pending bool `json:"pending"`
			projectagent.Event
		}
		if r := e.call(t, e.runID, fmt.Sprintf("%s-wait-%d", id, attempt), req, &data); !r.OK {
			t.Fatal("等待命令失败", r)
		}
		if !data.Pending {
			if data.Event.Seq <= e.seq || data.Event.Kind != "tool_result" {
				t.Fatalf("等待未返回工具结果：%+v", data)
			}
			e.seq = data.Event.Seq
			return data.Event
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatal("未取得命令结果")
	return projectagent.Event{}
}

func execGatedCommand() string {
	if runtime.GOOS == "windows" {
		return "Add-Content -LiteralPath 'counter.txt' -Value 'run'; while (-not (Test-Path -LiteralPath 'release')) { Start-Sleep -Milliseconds 100 }; Write-Output 'shell-result'"
	}
	return "printf 'run\\n' >> counter.txt; while [ ! -f release ]; do sleep 0.1; done; printf 'shell-result\\n'"
}

func (e *projectExecProbe) waitCommandStarted(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(filepath.Join(e.root, "counter.txt")); err == nil && strings.Contains(string(raw), "run") {
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
	var threads string
	err := e.stack.pool.QueryRow(context.Background(), `SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'status',status,'reason',status_reason)),'[]')::text FROM threads WHERE project_id=$1`, e.project.ID).Scan(&threads)
	t.Fatalf("真实 shell 命令未启动；Thread：%s（%v）；Coordinator：%s；节点：%s", threads, err, e.stack.coord.out.String(), e.stack.batond.out.String())
}

func (e *projectExecProbe) release(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(e.root, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
}

func (e *projectExecProbe) assertOneExecution(t *testing.T, threadID string) {
	t.Helper()
	var threads, turns int
	if err := e.stack.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM threads WHERE project_id=$1),(SELECT count(*) FROM thread_turns WHERE thread_id=$2)`, e.project.ID, threadID).Scan(&threads, &turns); err != nil || threads != 1 || turns != 1 {
		t.Fatalf("命令重复接受 threads=%d turns=%d：%v", threads, turns, err)
	}
	raw, err := os.ReadFile(filepath.Join(e.root, "counter.txt"))
	if err != nil || len(strings.Fields(string(raw))) != 1 {
		t.Fatalf("命令计数应为 1：%q %v", raw, err)
	}
}

func waitThreadStatus(t *testing.T, st *processStack, threadID, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT status FROM threads WHERE id=$1`, threadID).Scan(&got); err == nil && got == want {
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatalf("Thread %s 状态为 %q，期望 %q", threadID, got, want)
}

func TestProjectExecRealProcessesVersionWake(t *testing.T) {
	t.Parallel()
	e := startProjectExecStack(t)
	threadID, _ := e.start(t, "version-wake", execGatedCommand(), 600)
	e.waitCommandStarted(t)
	var pending struct {
		Pending  bool   `json:"pending"`
		ThreadID string `json:"thread_id"`
		Version  int64  `json:"version"`
		Protocol int    `json:"wait_protocol"`
	}
	request := protocol.ProjectRuntimeRequest{Operation: "wait_tool", ToolCallID: "version-wake", LastSeq: e.seq}
	if result := e.call(t, e.runID, "wake-snapshot", request, &pending); !result.OK || !pending.Pending || pending.ThreadID != threadID || pending.Protocol != 1 {
		t.Fatalf("Thread 等待快照无效: %+v %+v", result, pending)
	}
	payload, _ := json.Marshal(map[string]any{"thread_id": threadID, "after_version": pending.Version, "wait_ms": 15000})
	e.send(t, e.runID, "thread-local-poll", protocol.ProjectRuntimeRequest{Operation: "poll_wake", Payload: payload})
	// 同节点上的本机等待期间，其他请求仍可经过 Gateway 完成。
	if result := e.call(t, e.runID, "read-during-thread-wait", protocol.ProjectRuntimeRequest{Operation: "read_events"}, nil); !result.OK {
		t.Fatal("本机等待阻塞中心流量", result)
	}
	e.release(t)
	record := e.waitRecord(t, e.runID, "thread-local-poll")
	var result protocol.ProjectRuntimeResult
	if record.Error != "" || json.Unmarshal(record.Response, &result) != nil || !result.OK {
		t.Fatalf("Thread 通知等待失败: %+v", record)
	}
	var wake struct {
		Reason  string `json:"reason"`
		Version int64  `json:"version"`
	}
	if json.Unmarshal(result.Data, &wake) != nil || wake.Reason != "thread_changed" || wake.Version <= pending.Version {
		t.Fatalf("未由持久化 Thread 的新版本唤醒: %s", result.Data)
	}
	final := e.wait(t, "version-wake", false)
	if !strings.Contains(string(final.Payload), "shell-result") {
		t.Fatal("通知后未能取得原命令输出", string(final.Payload))
	}
	e.assertOneExecution(t, threadID)
}

func TestProjectExecRealProcessesExitAndOutput(t *testing.T) {
	t.Parallel()
	for _, code := range []int{0, 7} {
		t.Run(fmt.Sprintf("exit_%d", code), func(t *testing.T) {
			t.Parallel()
			e := startProjectExecStack(t)
			command := fmt.Sprintf("printf 'shell-stdout\\n'; printf 'shell-stderr\\n' >&2; exit %d", code)
			if runtime.GOOS == "windows" {
				command = fmt.Sprintf("[Console]::Out.WriteLine('shell-stdout'); [Console]::Error.WriteLine('shell-stderr'); exit %d", code)
			}
			threadID, req := e.start(t, "exit-output", command, 30)
			waitThreadStatus(t, e.stack, threadID, "stopped")
			result := e.wait(t, "exit-output", false)
			var replay projectagent.Event
			if r := e.call(t, e.runID, "exit-output-replay", req, &replay); !r.OK || replay.Seq != result.Seq || string(replay.Payload) != string(result.Payload) {
				t.Fatal("重复调用没有返回已保存结果", r, replay)
			}
			for _, fragment := range []string{"shell-stdout", "shell-stderr", "stopped", "exit_code"} {
				if !strings.Contains(string(result.Payload), fragment) {
					t.Fatalf("工具结果缺少 %q：%s", fragment, result.Payload)
				}
			}
			var exitCode int
			if err := e.stack.pool.QueryRow(context.Background(), `SELECT (metadata->>'exit_code')::int FROM thread_replies WHERE thread_id=$1 AND worker_turn_seq=1 ORDER BY worker_seq DESC LIMIT 1`, threadID).Scan(&exitCode); err != nil || exitCode != code {
				t.Fatalf("命令退出码不正确：%d %v", exitCode, err)
			}
			var pending, results int
			if err := e.stack.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type IN ('turn_ended','thread_reply') AND delivered_seq IS NULL),(SELECT count(*) FROM conversation_events WHERE conversation_id=$2 AND kind='tool_result')`, e.project.Agent.ID, e.project.Conversation.ID).Scan(&pending, &results); err != nil || pending != 0 || results != 1 {
				t.Fatalf("同步返回后仍有重复输入 pending=%d results=%d：%v", pending, results, err)
			}
			var delivered int
			if err := e.stack.pool.QueryRow(context.Background(), `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='turn_ended' AND delivered_seq=$2`, e.project.Agent.ID, result.Seq).Scan(&delivered); err != nil || delivered != 1 {
				t.Fatalf("完成通知没有标记到工具结果：%d %v", delivered, err)
			}
		})
	}
}

func TestProjectExecRealProcessesWaitExpiryContinuesCommand(t *testing.T) {
	t.Parallel()
	for _, force := range []bool{false, true} {
		t.Run(fmt.Sprintf("runtime_finishes_wait_%t", force), func(t *testing.T) {
			t.Parallel()
			e := startProjectExecStack(t)
			waitSeconds := 0
			if force {
				waitSeconds = 600
			}
			threadID, _ := e.start(t, "wait-expiry", execGatedCommand(), waitSeconds)
			e.waitCommandStarted(t)
			result := e.wait(t, "wait-expiry", force)
			if !strings.Contains(string(result.Payload), threadID) {
				t.Fatal("未返回继续运行的 Thread ID", string(result.Payload))
			}
			waitThreadStatus(t, e.stack, threadID, "running")
			e.release(t)
			waitThreadStatus(t, e.stack, threadID, "stopped")
			var claim projectagent.Claim
			if r := e.call(t, e.runID, "claim-completion", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: e.seq}, &claim); !r.OK || claim.Event == nil {
				t.Fatal("命令结束未送回新输入", r)
			}
			if !strings.Contains(string(claim.Event.Payload), threadID) || !strings.Contains(string(claim.Event.Payload), "shell-result") {
				t.Fatal("后续输入没有命令结果", string(claim.Event.Payload))
			}
			var duplicate projectagent.Claim
			if r := e.call(t, e.runID, "claim-again", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: claim.Event.Seq}, &duplicate); !r.OK || duplicate.Event != nil {
				t.Fatal("重复投递命令结果", r, duplicate.Event)
			}
			e.assertOneExecution(t, threadID)
		})
	}
}

func TestProjectExecRealProcessesBinaryOutputAndAsyncInput(t *testing.T) {
	t.Parallel()
	e := startProjectExecStack(t)
	original := make([]byte, 40<<10)
	for i := range original {
		original[i] = byte(i / 1024)
	}
	if err := os.WriteFile(filepath.Join(e.root, "output.bin"), original, 0600); err != nil {
		t.Fatal(err)
	}
	command := "printf 'run\\n' >> counter.txt; while [ ! -f release ]; do sleep 0.1; done; cat output.bin"
	if runtime.GOOS == "windows" {
		command = "Add-Content -LiteralPath 'counter.txt' -Value 'run'; while (-not (Test-Path -LiteralPath 'release')) { Start-Sleep -Milliseconds 100 }; $bytes = [IO.File]::ReadAllBytes((Join-Path (Get-Location) 'output.bin')); [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)"
	}
	threadID, _ := e.start(t, "binary-output", command, 0)
	e.waitCommandStarted(t)
	_ = e.wait(t, "binary-output", false)
	e.release(t)
	waitThreadStatus(t, e.stack, threadID, "stopped")
	var content, encoding string
	var truncated bool
	var originalBytes int64
	var exitCode int
	if err := e.stack.pool.QueryRow(context.Background(), `SELECT content,truncated,original_bytes,COALESCE(metadata->>'encoding',''),(metadata->>'exit_code')::int FROM thread_replies WHERE thread_id=$1 AND worker_turn_seq=1 ORDER BY worker_seq DESC LIMIT 1`, threadID).Scan(&content, &truncated, &originalBytes, &encoding, &exitCode); err != nil {
		t.Fatalf("命令回复未持久化：%v", err)
	}
	retained, err := base64.StdEncoding.DecodeString(content)
	want := append(append([]byte(nil), original[:16<<10]...), original[len(original)-(16<<10):]...)
	if err != nil || encoding != "base64" || originalBytes != int64(len(original)) || exitCode != 0 || !truncated || !bytes.Equal(retained, want) {
		t.Fatalf("二进制命令结果不完整：encoding=%s total=%d exit=%d truncated=%t retained=%d err=%v", encoding, originalBytes, exitCode, truncated, len(retained), err)
	}
	var claim projectagent.Claim
	if r := e.call(t, e.runID, "binary-claim", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: e.seq}, &claim); !r.OK || claim.Event == nil || claim.InputCount < 1 {
		t.Fatal("大输出未作为新输入返回", r, claim.InputCount)
	}
	var payload struct {
		Message struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(claim.Event.Payload, &payload); err != nil || len(payload.Message.Content) != 1 {
		t.Fatal("新输入格式错误", err)
	}
	var inputs []projectagent.QueuedInput
	if err := json.Unmarshal([]byte(payload.Message.Content[0].Text), &inputs); err != nil || len(inputs) == 0 {
		t.Fatal("新输入没有命令通知", err)
	}
	foundTurnEnded := false
	for _, in := range inputs {
		if in.SourceType != "turn_ended" {
			continue
		}
		var turnEnded struct {
			ThreadID      string `json:"thread_id"`
			CommandResult struct {
				Output     string `json:"output"`
				Encoding   string `json:"encoding"`
				TotalBytes int64  `json:"total_bytes"`
				ExitCode   int    `json:"exit_code"`
				Truncated  bool   `json:"truncated"`
			} `json:"command_result"`
		}
		if err := json.Unmarshal(in.Payload, &turnEnded); err != nil || turnEnded.ThreadID != threadID || turnEnded.CommandResult.Encoding != "base64" || turnEnded.CommandResult.TotalBytes != originalBytes || turnEnded.CommandResult.ExitCode != 0 || !turnEnded.CommandResult.Truncated || turnEnded.CommandResult.Output == "" {
			t.Fatalf("命令通知丢失了二进制输出: %s %v", in.Payload, err)
		}
		foundTurnEnded = true
	}
	if !foundTurnEnded {
		t.Fatal("未收到带 command_result 的 turn_ended 输入")
	}
	var duplicate projectagent.Claim
	if r := e.call(t, e.runID, "binary-claim-again", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: claim.Event.Seq}, &duplicate); !r.OK || duplicate.Event != nil {
		t.Fatal("大输出重复投递", r)
	}
	e.assertOneExecution(t, threadID)
}

func waitStoppedThreadOutput(t *testing.T, e *projectExecProbe, threadID string) store.Thread {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var view store.Thread
	for time.Now().Before(deadline) {
		var replyCount int
		_ = e.stack.pool.QueryRow(context.Background(), `SELECT count(*) FROM thread_replies WHERE thread_id=$1`, threadID).Scan(&replyCount)
		if err := getJSON(t, e.stack.client, e.stack.base+"/api/v1/threads/"+threadID, &view); err != nil {
			t.Fatal(err)
		}
		if view.Status == "stopped" && replyCount > 0 {
			return view
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("停止后的命令输出未补送: %+v", view)
	return view
}

func TestProjectExecRealProcessesCancelAndTimeoutKeepPartialOutput(t *testing.T) {
	t.Parallel()
	for _, reason := range []string{"stopped", "timeout"} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			e := startProjectExecStack(t)
			command := "printf 'partial-before-stop\\n'; printf '%s' $$ > command.pid; printf 'run\\n' >> counter.txt; while [ ! -f release ]; do sleep 0.1; done"
			if runtime.GOOS == "windows" {
				command = "[Console]::Out.WriteLine('partial-before-stop'); Set-Content -LiteralPath 'command.pid' -Value $PID; Add-Content -LiteralPath 'counter.txt' -Value 'run'; while (-not (Test-Path -LiteralPath 'release')) { Start-Sleep -Milliseconds 100 }"
			}
			timeout := 60
			if reason == "timeout" {
				timeout = 2
			}
			threadID, _ := e.start(t, "stop-command", command, 0, timeout)
			e.waitCommandStarted(t)
			_ = e.wait(t, "stop-command", false)
			pidRaw, err := os.ReadFile(filepath.Join(e.root, "command.pid"))
			if err != nil {
				t.Fatal("命令未记录进程号", err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(pidRaw)))
			if err != nil || pid <= 0 {
				t.Fatal("命令进程号无效", err)
			}
			if reason == "stopped" {
				if code := postJSON(t, e.stack.client, e.stack.base+"/api/v1/threads/"+threadID+"/stop", map[string]any{}, e.stack.csrf, nil); code != 202 {
					t.Fatalf("停止命令返回 %d", code)
				}
			}
			view := waitStoppedThreadOutput(t, e, threadID)
			if view.Status != "stopped" {
				t.Fatalf("命令停止状态错误：%+v", view)
			}
			var endReason, content string
			if err := e.stack.pool.QueryRow(context.Background(), `SELECT COALESCE(t.end_reason,''),COALESCE(r.content,'') FROM thread_turns t LEFT JOIN thread_replies r ON r.turn_id=t.id WHERE t.thread_id=$1 AND t.worker_turn_seq=1`, threadID).Scan(&endReason, &content); err != nil || endReason != reason || !strings.Contains(content, "partial-before-stop") {
				t.Fatalf("停止或超时丢失已输出内容：reason=%q content=%q err=%v", endReason, content, err)
			}
			var claim projectagent.Claim
			if r := e.call(t, e.runID, "stop-claim", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: e.seq}, &claim); !r.OK || claim.Event == nil || claim.InputCount < 1 {
				t.Fatal("停止命令未送回结果输入", r, claim.InputCount)
			}
			if !strings.Contains(string(claim.Event.Payload), "partial-before-stop") {
				t.Fatal("停止通知缺少命令输出", string(claim.Event.Payload))
			}
			var duplicate projectagent.Claim
			if r := e.call(t, e.runID, "stop-claim-again", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: claim.Event.Seq}, &duplicate); !r.OK || duplicate.Event != nil {
				t.Fatal("停止结果重复投递", r)
			}
			if err := processAlive(pid); err == nil {
				t.Fatal("停止回执后命令进程仍存在")
			}
			e.assertOneExecution(t, threadID)
		})
	}
}

func TestProjectExecRealProcessesRuntimeCrashDoesNotRepeat(t *testing.T) {
	t.Parallel()
	e := startProjectExecStack(t)
	threadID, req := e.start(t, "recover-command", execGatedCommand(), 600)
	e.waitCommandStarted(t)
	runtimeFaultCommand(t, e.projectRuntimeProbe, e.runID, "runtime-waiting", "before_result", protocol.ProjectRuntimeRequest{Operation: "wait_tool", ToolCallID: "recover-command", LastSeq: e.seq})
	killRuntimeAtBoundary(t, e.projectRuntimeProbe, e.runID, "runtime-waiting")
	e.runID, _ = waitProjectRun(t, e.projectRuntimeProbe, e.project, e.runID)
	var boot projectagent.Bootstrap
	if r := e.call(t, e.runID, "recover-bootstrap", protocol.ProjectRuntimeRequest{Operation: "bootstrap"}, &boot); !r.OK {
		t.Fatal(r)
	}
	e.seq, req.LastSeq = boot.LastSeq, boot.LastSeq
	var pending struct {
		ThreadID string `json:"thread_id"`
	}
	if r := e.call(t, e.runID, "recover-call", req, &pending); !r.OK || pending.ThreadID != threadID {
		t.Fatal("恢复没有继续等待原 Thread", r, pending.ThreadID)
	}
	e.release(t)
	waitThreadStatus(t, e.stack, threadID, "stopped")
	result := e.wait(t, "recover-command", false)
	if !strings.Contains(string(result.Payload), "shell-result") {
		t.Fatal(string(result.Payload))
	}
	e.assertOneExecution(t, threadID)
}

func TestProjectExecRealProcessesWorkerCrashNeedsVerification(t *testing.T) {
	t.Parallel()
	e := startProjectExecStack(t)
	threadID, _ := e.start(t, "worker-crash", execGatedCommand(), 0)
	e.waitCommandStarted(t)
	worker := workerStatus(t, e.stack.dataDir, threadID)
	process, err := os.FindProcess(worker.PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = process.Release()
	e.release(t)
	waitThreadStatus(t, e.stack, threadID, "unknown")
	e.assertOneExecution(t, threadID)
}

func TestProjectExecRealProcessesReportedAndLocalOptOut(t *testing.T) {
	t.Parallel()
	for _, stale := range []bool{false, true} {
		t.Run(fmt.Sprintf("stale_report_%t", stale), func(t *testing.T) {
			t.Parallel()
			e := startProjectExecStack(t)
			e.enable(t, false)
			if stale {
				if _, err := e.stack.pool.Exec(context.Background(), `UPDATE node_runtime_reports SET report=jsonb_set(report,'{exec,enabled}','true') WHERE node_id=$1`, e.stack.ident.NodeID); err != nil {
					t.Fatal(err)
				}
			}
			req := e.save(t, "disabled", execGatedCommand(), 30)
			var data struct {
				Pending  bool   `json:"pending"`
				ThreadID string `json:"thread_id"`
				projectagent.Event
			}
			if r := e.call(t, e.runID, "disabled-call", req, &data); !r.OK {
				t.Fatal(r)
			}
			if stale {
				if !data.Pending || data.ThreadID == "" {
					t.Fatal("陈旧报告未到达本地开关验证", data)
				}
				waitThreadStatus(t, e.stack, data.ThreadID, "stopped")
				_ = e.wait(t, "disabled", false)
			} else if !processToolError(t, data.Event) {
				t.Fatal("中心接受未开启的节点", string(data.Event.Payload))
			}
			if !stale {
				var count int
				if err := e.stack.pool.QueryRow(context.Background(), `SELECT count(*) FROM threads WHERE project_id=$1`, e.project.ID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("中心拒绝命令后产生 Thread：%d %v", count, err)
				}
			}
			if _, err := os.Stat(filepath.Join(e.root, "counter.txt")); !os.IsNotExist(err) {
				t.Fatal("关闭开关后仍执行命令", err)
			}
		})
	}
}

package gateway_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"baton/internal/projectagent"
	"baton/internal/protocol"
)

func toolProcessRequest(id, name string, args any, last int64) protocol.ProjectRuntimeRequest {
	raw, _ := json.Marshal(args)
	return protocol.ProjectRuntimeRequest{Operation: "call_tool", ToolCallID: id, ToolName: name, Arguments: raw, LastSeq: last}
}
func assistantToolRequest(id, name string, args any, last int64) protocol.ProjectRuntimeRequest {
	payload, _ := json.Marshal(map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": args}}}})
	return protocol.ProjectRuntimeRequest{Operation: "append_event", ClientEventID: "assistant-" + id, Payload: payload, LastSeq: last}
}
func processToolError(t *testing.T, e projectagent.Event) bool {
	t.Helper()
	var p struct {
		Message struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(e.Payload, &p); err != nil || len(p.Message.Content) != 1 {
		t.Fatal("工具结果格式", err)
	}
	if len(p.Message.Content[0].Text) > 32<<10 || len(e.Payload) > 32<<10 {
		t.Fatal("工具输出超限")
	}
	return p.Message.IsError
}
func runtimeFaultCommand(t *testing.T, p *projectRuntimeProbe, runID, id, fault string, req protocol.ProjectRuntimeRequest) {
	t.Helper()
	f, err := os.OpenFile(p.commands, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err = json.NewEncoder(f).Encode(map[string]any{"id": id, "run_id": runID, "request": req, "fault": fault}); err != nil {
		t.Fatal(err)
	}
}
func killRuntimeAtBoundary(t *testing.T, p *projectRuntimeProbe, runID, id string) {
	t.Helper()
	r := p.waitRecord(t, runID, id+"-boundary")
	process, err := os.FindProcess(r.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	if err = process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitRuntimePIDStopped(t, r.PID)
	waitProjectRunEnded(t, p, runID)
}

func startProjectThreadToolsStack(t *testing.T) (*projectRuntimeProbe, string) {
	t.Helper()
	dir := t.TempDir()
	installProjectRuntime(t, dir)
	piBin := filepath.Join(dir, "pi")
	if runtime.GOOS == "windows" {
		piBin += ".cmd"
	}
	if runtime.GOOS == "windows" {
		if err := os.WriteFile(piBin, []byte("@echo off\r\necho 1.3.0\r\n"), 0700); err != nil {
			t.Fatal(err)
		}
	} else {
		if err := os.WriteFile(piBin, []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '1.3.0\\n'; exit 0; fi\nwhile :; do sleep 1; done\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	p := &projectRuntimeProbe{commands: filepath.Join(dir, "commands.jsonl"), log: filepath.Join(dir, "runtime.jsonl")}
	if err := os.WriteFile(p.commands, nil, 0600); err != nil {
		t.Fatal(err)
	}
	p.stack = startProjectStack(t, map[string]string{
		"BATON_PI_BIN":                        piBin,
		"PATH":                                dir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"BATON_TEST_PROJECT_RUNTIME_COMMANDS": p.commands,
		"BATON_TEST_PROJECT_RUNTIME_LOG":      p.log,
	})
	rawRoot := t.TempDir()
	root, err := filepath.EvalSymlinks(rawRoot)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(p.stack.batondBin, "files", "add", "--data-dir", p.stack.dataDir, "--id", "tools-root", "--path", root).CombinedOutput(); err != nil {
		t.Fatalf("登记工作目录失败：%v %s", err, out)
	}
	waitRuntimeReport(t, p.stack, func(r protocol.RuntimeReport) bool {
		if r.ProjectRuntime == nil || len(r.Roots) != 1 {
			return false
		}
		for _, a := range r.Agents {
			if a.AgentType == "pi" && a.Status == "available" && a.Capabilities.Create {
				return true
			}
		}
		return false
	})
	return p, root
}

func TestProjectToolsRealProcessesCrashRecovery(t *testing.T) {
	t.Parallel()
	for _, boundary := range []string{"assistant_before", "assistant_after", "transaction_before", "transaction_during", "transaction_after", "result_before", "result_after"} {
		t.Run(boundary, func(t *testing.T) {
			t.Parallel()
			p, root := startProjectThreadToolsStack(t)
			st := p.stack
			ctx := context.Background()
			project := createRuntimeProject(t, p)
			messageRuntimeProject(t, p, project, "tool-input")
			runID, _ := waitProjectRun(t, p, project, "")
			var claim projectagent.Claim
			if r := p.call(t, runID, "claim", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, &claim); !r.OK || claim.Event == nil {
				t.Fatal(r)
			}
			args := map[string]any{"node_id": st.ident.NodeID, "agent_type": "pi", "working_directory": root, "message": "模型替身开启 Thread"}
			appendReq := assistantToolRequest("dispatch", "threads.create", args, claim.Event.Seq)
			toolReq := toolProcessRequest("dispatch", "threads.create", args, claim.Event.Seq+1)
			switch boundary {
			case "assistant_before":
				runtimeFaultCommand(t, p, runID, "fault", "before_request", appendReq)
			case "assistant_after":
				runtimeFaultCommand(t, p, runID, "fault", "after_result", appendReq)
			default:
				if r := p.call(t, runID, "save", appendReq, nil); !r.OK {
					t.Fatal(r)
				}
				switch boundary {
				case "transaction_before":
					runtimeFaultCommand(t, p, runID, "fault", "before_request", toolReq)
				case "transaction_during":
					// 在结果 INSERT 时阻塞，Thread 新建已经发生但尚未提交；关闭中心使事务回滚。
					lock, err := st.pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer lock.Rollback(ctx)
					if _, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 157157))`); err != nil {
						t.Fatal(err)
					}
					if _, err = st.pool.Exec(ctx, `CREATE FUNCTION block_tool_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='tool_result' THEN PERFORM pg_advisory_xact_lock(hashtextextended(current_schema(), 157157)); END IF; RETURN NEW; END $$; CREATE TRIGGER block_tool_result BEFORE INSERT ON conversation_events FOR EACH ROW EXECUTE FUNCTION block_tool_result()`); err != nil {
						t.Fatal(err)
					}
					var blockerPID int
					if err = lock.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
						t.Fatal(err)
					}
					p.send(t, runID, "blocked", toolReq)
					deadline := time.Now().Add(10 * time.Second)
					blocked := false
					for time.Now().Before(deadline) {
						if err = st.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'INSERT INTO conversation_events%')`, blockerPID).Scan(&blocked); err != nil {
							t.Fatal(err)
						}
						if blocked {
							break
						}
						time.Sleep(20 * time.Millisecond)
					}
					if !blocked {
						t.Fatal("工具事务没有到达结果写入边界")
					}
					start := p.waitRecord(t, runID, "start")
					process, err := os.FindProcess(start.PID)
					if err != nil {
						t.Fatal(err)
					}
					if err = process.Kill(); err != nil {
						t.Fatal(err)
					}
					_ = process.Release()
					waitRuntimePIDStopped(t, start.PID)
					st.coord.stop()
					_ = lock.Rollback(ctx)
					if _, err = st.pool.Exec(ctx, `DROP TRIGGER block_tool_result ON conversation_events; DROP FUNCTION block_tool_result()`); err != nil {
						t.Fatal(err)
					}
					var threads int
					if err = st.pool.QueryRow(ctx, `SELECT count(*) FROM threads WHERE project_id=$1`, project.ID).Scan(&threads); err != nil || threads != 0 {
						t.Fatalf("未提交 Thread 残留 %d %v", threads, err)
					}
					if _, err = st.pool.Exec(ctx, `UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, project.Agent.ID); err != nil {
						t.Fatal(err)
					}
					restartRelay(t, st)
				case "transaction_after", "result_before":
					runtimeFaultCommand(t, p, runID, "fault", "before_result", toolReq)
				case "result_after":
					runtimeFaultCommand(t, p, runID, "fault", "after_result", toolReq)
				}
			}
			if boundary != "transaction_during" {
				killRuntimeAtBoundary(t, p, runID, "fault")
			}
			// 进程被杀后，从中心已保存的历史继续；请求和工具标识保持不变。
			recovered, _ := waitProjectRun(t, p, project, runID)
			var boot projectagent.Bootstrap
			if r := p.call(t, recovered, "bootstrap", protocol.ProjectRuntimeRequest{Operation: "bootstrap"}, &boot); !r.OK {
				t.Fatal(r)
			}
			if boundary == "assistant_before" {
				if boot.LastSeq != claim.Event.Seq {
					t.Fatal("未保存的 assistant 出现在历史")
				}
				if r := p.call(t, recovered, "save-recovered", appendReq, nil); !r.OK {
					t.Fatal(r)
				}
				boot.LastSeq++
			}
			toolReq.LastSeq = boot.LastSeq
			var result projectagent.Event
			if r := p.call(t, recovered, "replay", toolReq, &result); !r.OK || processToolError(t, result) {
				t.Fatal(r)
			}
			var threads, results int
			var last int64
			if err := st.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM threads WHERE project_id=$1),(SELECT count(*) FROM conversation_events WHERE conversation_id=$2 AND kind='tool_result' AND tool_call_id='dispatch'),(SELECT next_seq-1 FROM conversations WHERE id=$2)`, project.ID, project.Conversation.ID).Scan(&threads, &results, &last); err != nil || threads != 1 || results != 1 || last != result.Seq {
				t.Fatalf("恢复分叉 threads=%d results=%d last=%d result=%d %v", threads, results, last, result.Seq, err)
			}
			if r := p.call(t, recovered, "replay-again", toolReq, &result); !r.OK {
				t.Fatal(r)
			}
			p.send(t, recovered, "finish", protocol.ProjectRuntimeRequest{Operation: "finish", Reason: "fixture_complete"})
			waitProjectRunEnded(t, p, recovered)
			t.Logf("%s：杀掉 Runtime 后恢复，Thread=1，tool_result=1，连续历史 seq=%d", boundary, last)
		})
	}
}

func TestProjectToolsRealProcessesMissingDirectoryAndSecurity(t *testing.T) {
	t.Parallel()
	p, root := startProjectThreadToolsStack(t)
	st := p.stack
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "tools")
	runID, _ := waitProjectRun(t, p, project, "")
	var claim projectagent.Claim
	if r := p.call(t, runID, "claim", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, &claim); !r.OK {
		t.Fatal(r)
	}
	seq := claim.Event.Seq
	invoke := func(id, name string, args any) projectagent.Event {
		t.Helper()
		var saved projectagent.Event
		if r := p.call(t, runID, id+"-save", assistantToolRequest(id, name, args, seq), &saved); !r.OK {
			t.Fatal(r)
		}
		seq = saved.Seq
		var result projectagent.Event
		if r := p.call(t, runID, id+"-call", toolProcessRequest(id, name, args, seq), &result); !r.OK {
			t.Fatal(r)
		}
		seq = result.Seq
		return result
	}
	args := map[string]any{"node_id": st.ident.NodeID, "agent_type": "pi", "working_directory": filepath.Join(root, "missing"), "message": "检查缺失目录"}
	result := invoke("missing", "threads.create", args)
	if processToolError(t, result) {
		t.Fatal(string(result.Payload))
	}
	var id, status, reason string
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		err := st.pool.QueryRow(context.Background(), `SELECT id::text,status,status_reason FROM threads WHERE project_id=$1`, project.ID).Scan(&id, &status, &reason)
		if err == nil && status == "stopped" && reason != "" {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if status != "stopped" || reason == "" {
		t.Fatalf("不存在目录的 Thread 状态 %s reason=%q", status, reason)
	}
	for _, name := range []string{"nodes.exec", "inbox.ask", "unknown.tool", "memory.write"} {
		if result = invoke(fmt.Sprintf("bad-%d", seq), name, map[string]any{"project_id": newProcessID(t), "employee_id": newProcessID(t)}); !processToolError(t, result) {
			t.Fatal("越权工具成功", name)
		}
	}
	for _, name := range []string{"memory.search", "history.search", "history.read", "devices.list", "threads.list"} {
		if result = invoke(fmt.Sprintf("read-%d", seq), name, map[string]any{}); processToolError(t, result) {
			t.Fatal(name, string(result.Payload))
		}
	}
	if result = invoke("get", "threads.get", map[string]any{"thread_id": id}); processToolError(t, result) {
		t.Fatal(string(result.Payload))
	}
	if result = invoke("read", "threads.read", map[string]any{"thread_id": id}); processToolError(t, result) {
		t.Fatal(string(result.Payload))
	}
	p.send(t, runID, "finish", protocol.ProjectRuntimeRequest{Operation: "finish", Reason: "fixture_complete"})
	waitProjectRunEnded(t, p, runID)
}

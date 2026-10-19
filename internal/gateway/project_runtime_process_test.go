package gateway_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"baton/internal/inbox"
	"baton/internal/projectagent"
	"baton/internal/protocol"
)

type projectRuntimeProbe struct {
	stack    *prepareStack
	commands string
	log      string
}

type projectRuntimeRecord struct {
	ID       string          `json:"id"`
	RunID    string          `json:"run_id"`
	PID      int             `json:"pid"`
	Response json.RawMessage `json:"response"`
	Error    string          `json:"error"`
}

func startProjectRuntimeStack(t *testing.T) *projectRuntimeProbe {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", binary, "./testdata/project_runtime.go").CombinedOutput(); err != nil {
		t.Fatalf("构建 Runtime 契约程序失败：%v %s", err, out)
	}
	p := &projectRuntimeProbe{commands: filepath.Join(dir, "commands.jsonl"), log: filepath.Join(dir, "runtime.jsonl")}
	if err := os.WriteFile(p.commands, nil, 0600); err != nil {
		t.Fatal(err)
	}
	p.stack = startPrepareStack(t, map[string]string{
		"PATH":                                dir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"BATON_TEST_PROJECT_RUNTIME_COMMANDS": p.commands,
		"BATON_TEST_PROJECT_RUNTIME_LOG":      p.log,
	})
	waitRuntimeReport(t, p.stack, func(r protocol.RuntimeReport) bool {
		return r.ProjectRuntime != nil && len(r.ProjectRuntime.Providers) > 0
	})
	return p
}

func (p *projectRuntimeProbe) records(t *testing.T) []projectRuntimeRecord {
	t.Helper()
	f, err := os.Open(p.log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := []projectRuntimeRecord{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 512<<10)
	for scanner.Scan() {
		var r projectRuntimeRecord
		// 另一个进程可能尚未写完最后一行，下一次读取会取得完整记录。
		if json.Unmarshal(scanner.Bytes(), &r) == nil {
			out = append(out, r)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func (p *projectRuntimeProbe) waitRecord(t *testing.T, runID, id string) projectRuntimeRecord {
	t.Helper()
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		for _, r := range p.records(t) {
			if r.RunID == runID && r.ID == id {
				return r
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("未取得 Runtime 记录 %s/%s；Coordinator：%s；节点：%s；记录：%+v", runID, id, p.stack.coord.out.String(), p.stack.batond.out.String(), p.records(t))
	return projectRuntimeRecord{}
}

func (p *projectRuntimeProbe) send(t *testing.T, runID, id string, req protocol.ProjectRuntimeRequest) {
	t.Helper()
	f, err := os.OpenFile(p.commands, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(map[string]any{"id": id, "run_id": runID, "request": req}); err != nil {
		t.Fatal(err)
	}
}

func (p *projectRuntimeProbe) call(t *testing.T, runID, id string, req protocol.ProjectRuntimeRequest, out any) protocol.ProjectRuntimeResult {
	t.Helper()
	p.send(t, runID, id, req)
	r := p.waitRecord(t, runID, id)
	if r.Error != "" {
		t.Fatalf("Runtime IPC 失败：%s", r.Error)
	}
	var result protocol.ProjectRuntimeResult
	if err := json.Unmarshal(r.Response, &result); err != nil {
		t.Fatalf("Runtime 响应无效：%v %s", err, r.Response)
	}
	if out != nil && result.OK {
		if err := json.Unmarshal(result.Data, out); err != nil {
			t.Fatalf("Runtime 数据无效：%v %s", err, result.Data)
		}
	}
	return result
}

func runtimeProjectHTTP(t *testing.T, st *prepareStack, method, path string, payload, out any, want int) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, st.base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://baton.example")
	req.Header.Set("X-CSRF-Token", st.csrf)
	resp, err := st.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s 返回 %d，期望 %d：%s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("API 响应无效：%v %s", err, raw)
		}
	}
}

func createRuntimeProject(t *testing.T, p *projectRuntimeProbe) projectagent.Project {
	t.Helper()
	var project projectagent.Project
	runtimeProjectHTTP(t, p.stack, "POST", "/api/v1/projects", projectagent.CreateInput{Title: "进程验证", Goal: "验证输入与租约", Provider: "openai-codex", Model: "fake-model"}, &project, 201)
	return project
}

func messageRuntimeProject(t *testing.T, p *projectRuntimeProbe, project projectagent.Project, id string) {
	t.Helper()
	runtimeProjectHTTP(t, p.stack, "POST", "/api/v1/projects/"+project.ID+"/messages", projectagent.MessageInput{ClientMessageID: id, Content: "处理消息 " + id}, nil, 202)
}

func waitProjectRun(t *testing.T, p *projectRuntimeProbe, project projectagent.Project, previous string) (string, int64) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var runID string
	var epoch int64
	for time.Now().Before(deadline) {
		err := p.stack.pool.QueryRow(context.Background(), `SELECT COALESCE(lease_run_id::text,''),lease_epoch FROM project_agents WHERE id=$1`, project.Agent.ID).Scan(&runID, &epoch)
		if err == nil && runID != "" && runID != previous {
			p.waitRecord(t, runID, "start")
			return runID, epoch
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("未放置新运行：%s epoch %d；Coordinator：%s；节点：%s", runID, epoch, p.stack.coord.out.String(), p.stack.batond.out.String())
	return "", 0
}

func waitProjectRunEnded(t *testing.T, p *projectRuntimeProbe, runID string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var reason string
	for time.Now().Before(deadline) {
		err := p.stack.pool.QueryRow(context.Background(), `SELECT COALESCE(end_reason,'') FROM agent_runs WHERE id=$1 AND ended_at IS NOT NULL`, runID).Scan(&reason)
		if err == nil {
			return reason
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("运行未结束 %s；Coordinator：%s；节点：%s", runID, p.stack.coord.out.String(), p.stack.batond.out.String())
	return ""
}

func TestProjectRuntimeRealProcessesPlacementPagingAndWake(t *testing.T) {
	p := startProjectRuntimeStack(t)
	st := p.stack
	project := createRuntimeProject(t, p)
	runtimeProjectHTTP(t, st, "PATCH", "/api/v1/projects/"+project.ID, map[string]any{"title": "有被动更新"}, nil, 200)
	memoryID := newProcessID(t)
	runtimeProjectHTTP(t, st, "PUT", "/api/v1/projects/"+project.ID+"/memory/"+memoryID, map[string]any{"title": "偏好", "content": "中文", "expected_revision": 0}, nil, 200)
	time.Sleep(1500 * time.Millisecond)
	var runs int
	if err := st.pool.QueryRow(context.Background(), `SELECT count(*) FROM agent_runs WHERE agent_id=$1`, project.Agent.ID).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("被动输入触发了放置：%d %v", runs, err)
	}
	// 压缩后的新增历史超过 1 MiB，Runtime 必须经真实 Gateway 逐页取回。
	compaction := json.RawMessage(`{"through_seq":0,"summary":"此前没有对话内容","cleared_tool_result_seqs":[],"memory_index":[]}`)
	if _, err := st.pool.Exec(context.Background(), `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES($1,1,$2,'compaction',$3)`, project.Conversation.ID, st.employeeID, compaction); err != nil {
		t.Fatal(err)
	}
	expected := map[int64]json.RawMessage{1: compaction}
	for seq := int64(2); seq <= 21; seq++ {
		payload, _ := json.Marshal(map[string]any{"format": "pi-ai/1", "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": strconv.FormatInt(seq, 10) + strings.Repeat("x", 60<<10)}}}})
		if _, err := st.pool.Exec(context.Background(), `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES($1,$2,$3,'assistant',$4)`, project.Conversation.ID, seq, st.employeeID, payload); err != nil {
			t.Fatal(err)
		}
		expected[seq] = payload
	}
	if _, err := st.pool.Exec(context.Background(), `UPDATE conversations SET next_seq=22,compaction_seq=1 WHERE id=$1`, project.Conversation.ID); err != nil {
		t.Fatal(err)
	}
	messageRuntimeProject(t, p, project, "first")
	runID, epoch := waitProjectRun(t, p, project, "")
	started := p.waitRecord(t, runID, "start")
	var boot projectagent.Bootstrap
	if r := p.call(t, runID, "bootstrap", protocol.ProjectRuntimeRequest{Operation: "bootstrap", RunID: newProcessID(t), LeaseEpoch: epoch + 100}, &boot); !r.OK || boot.Project.ID != project.ID || boot.LastSeq != 21 || boot.AfterSeq != 0 || boot.Compaction == nil || boot.Compaction.Seq != 1 || boot.Compaction.Kind != "compaction" {
		t.Fatalf("bootstrap 不正确：%+v %+v", r, boot)
	}
	after := boot.AfterSeq
	pages, bytesRead := 0, 0
	for after < boot.LastSeq {
		var page projectagent.EventPage
		result := p.call(t, runID, fmt.Sprintf("page-%d", pages), protocol.ProjectRuntimeRequest{Operation: "read_events", AfterSeq: after, MaxBytes: 128 << 10}, &page)
		if !result.OK || len(page.Events) == 0 || len(result.Data) > 128<<10 {
			t.Fatalf("分页失败：%+v", result)
		}
		for _, event := range page.Events {
			if event.Seq != after+1 {
				t.Fatalf("分页序号不连续：after=%d event=%d", after, event.Seq)
			}
			var want, got any
			_ = json.Unmarshal(expected[event.Seq], &want)
			_ = json.Unmarshal(event.Payload, &got)
			wantJSON, _ := json.Marshal(want)
			gotJSON, _ := json.Marshal(got)
			if !bytes.Equal(wantJSON, gotJSON) {
				t.Fatalf("第 %d 条事件内容改变", event.Seq)
			}
			after = event.Seq
			bytesRead += len(event.Payload)
		}
		if page.NextAfterSeq != after || page.HasMore != (after < boot.LastSeq) {
			t.Fatalf("分页游标不正确：%+v", page)
		}
		pages++
	}
	if bytesRead <= 1<<20 || pages < 2 {
		t.Fatalf("未覆盖累计 1 MiB 分页：%d bytes %d pages", bytesRead, pages)
	}
	var claim projectagent.Claim
	if r := p.call(t, runID, "claim-first", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: 21}, &claim); !r.OK || claim.Event == nil || claim.InputCount != 3 {
		t.Fatalf("主动和被动输入未一同领取：%+v %+v", r, claim)
	}
	var delivered int
	if err := st.pool.QueryRow(context.Background(), `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND delivered_seq=$2`, project.Agent.ID, claim.Event.Seq).Scan(&delivered); err != nil || delivered != 3 {
		t.Fatalf("领取事件与队列投递序号不一致：%d %v", delivered, err)
	}
	var empty projectagent.Claim
	if r := p.call(t, runID, "claim-empty", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: claim.Event.Seq}, &empty); !r.OK || empty.Event != nil || empty.InputCount != 0 {
		t.Fatalf("重复领取生成输入事件：%+v %+v", r, empty)
	}
	// 同一有效运行收到新输入时，唤醒沿中心、Gateway、batond 和本地 IPC 传播。
	p.send(t, runID, "wake", protocol.ProjectRuntimeRequest{Operation: "poll_wake"})
	messageRuntimeProject(t, p, project, "second")
	wake := p.waitRecord(t, runID, "wake")
	var wakeResult protocol.ProjectRuntimeResult
	_ = json.Unmarshal(wake.Response, &wakeResult)
	if !wakeResult.OK || !strings.Contains(string(wakeResult.Data), `"wake":true`) {
		t.Fatalf("未唤醒原 Runtime：%s %s", wake.Response, wake.Error)
	}
	if r := p.call(t, runID, "claim-second", protocol.ProjectRuntimeRequest{Operation: "claim_inputs", LastSeq: claim.Event.Seq}, &claim); !r.OK || claim.Event == nil || claim.InputCount != 1 {
		t.Fatalf("新输入未领取：%+v %+v", r, claim)
	}
	// 回退中心的启动回执状态，模拟 ACK 丢失后重投同一 run。
	if _, err := st.pool.Exec(context.Background(), `UPDATE agent_runs SET state='starting' WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	ackDeadline := time.Now().Add(5 * time.Second)
	acked := false
	for time.Now().Before(ackDeadline) {
		if err := st.pool.QueryRow(context.Background(), `SELECT state='running' FROM agent_runs WHERE id=$1`, runID).Scan(&acked); err != nil {
			t.Fatal(err)
		}
		if acked {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if !acked {
		t.Fatal("重投启动命令未取得回执")
	}
	// Coordinator 重启使节点重连，Runtime 继续使用原进程。
	restartRelay(t, st)
	if r := p.call(t, runID, "bootstrap-after-reconnect", protocol.ProjectRuntimeRequest{Operation: "bootstrap"}, &boot); !r.OK {
		t.Fatalf("重连后原 Runtime 无法使用：%+v", r)
	}
	starts := 0
	for _, r := range p.records(t) {
		if r.RunID == runID && r.ID == "start" {
			starts++
			if r.PID != started.PID {
				t.Fatal("同一运行更换了进程")
			}
		}
	}
	if starts != 1 {
		t.Fatalf("同一 run 启动了 %d 次", starts)
	}
	p.send(t, runID, "finish", protocol.ProjectRuntimeRequest{Operation: "finish", Reason: "idle"})
	waitProjectRunEnded(t, p, runID)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && processAlive(started.PID) == nil {
		time.Sleep(30 * time.Millisecond)
	}
	if processAlive(started.PID) == nil {
		t.Fatal("finish 后 Runtime 仍然存活")
	}
	t.Logf("真实 Coordinator/Gateway/batond 和 Runtime 契约进程：epoch=%d，历史 %d 字节、%d 页；被动放置、主动领取、唤醒、重连去重和 finish 通过", epoch, bytesRead, pages)
}

func waitRuntimePIDStopped(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if processAlive(pid) != nil {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("Runtime 进程 %d 未停止", pid)
}

func TestProjectRuntimeRealProcessesLeaseLossAndPause(t *testing.T) {
	p := startProjectRuntimeStack(t)
	st := p.stack
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "before-loss")
	runID, epoch := waitProjectRun(t, p, project, "")
	started := p.waitRecord(t, runID, "start")
	var claim projectagent.Claim
	if r := p.call(t, runID, "claim-before-loss", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, &claim); !r.OK || claim.Event == nil {
		t.Fatalf("断租前领取失败：%+v", r)
	}
	// 只调整本测试独立 schema 的租约时间，避免等待一分钟。
	if _, err := st.pool.Exec(context.Background(), `UPDATE project_agents SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, project.Agent.ID); err != nil {
		t.Fatal(err)
	}
	result := p.call(t, runID, "stale-bootstrap", protocol.ProjectRuntimeRequest{Operation: "bootstrap"}, nil)
	if result.OK || result.Code != "lease_lost" {
		t.Fatalf("旧运行请求被接受：%+v", result)
	}
	waitRuntimePIDStopped(t, started.PID)
	messageRuntimeProject(t, p, project, "after-loss")
	nextRun, nextEpoch := waitProjectRun(t, p, project, runID)
	if nextEpoch <= epoch {
		t.Fatalf("恢复运行未提高 epoch：%d -> %d", epoch, nextEpoch)
	}
	var boot projectagent.Bootstrap
	if r := p.call(t, nextRun, "bootstrap-recovered", protocol.ProjectRuntimeRequest{Operation: "bootstrap"}, &boot); !r.OK || boot.LastSeq != claim.Event.Seq {
		t.Fatalf("恢复运行未读到原中心历史：%+v %+v", r, boot)
	}
	nextStarted := p.waitRecord(t, nextRun, "start")
	runtimeProjectHTTP(t, st, "PATCH", "/api/v1/projects/"+project.ID, map[string]any{"status": "paused"}, nil, 200)
	waitProjectRunEnded(t, p, nextRun)
	waitRuntimePIDStopped(t, nextStarted.PID)
	var leaseEmpty bool
	if err := st.pool.QueryRow(context.Background(), `SELECT lease_run_id IS NULL AND lease_until IS NULL FROM project_agents WHERE id=$1`, project.Agent.ID).Scan(&leaseEmpty); err != nil || !leaseEmpty {
		t.Fatalf("暂停未释放租约：%v %v", leaseEmpty, err)
	}
	t.Logf("真实进程断租拒绝 lease_lost、停止旧进程、epoch %d -> %d 恢复中心历史、暂停停止通过", epoch, nextEpoch)
}

func TestProjectRuntimeRealProcessesFailureAndRetry(t *testing.T) {
	p := startProjectRuntimeStack(t)
	st := p.stack
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "retry-input")
	previous := ""
	var runID string
	for failure := 1; failure <= 3; failure++ {
		runID, _ = waitProjectRun(t, p, project, previous)
		started := p.waitRecord(t, runID, "start")
		result := p.call(t, runID, "report-failure", protocol.ProjectRuntimeRequest{Operation: "report_failure", Reason: "model_test_failure"}, nil)
		if !result.OK {
			t.Fatalf("报告模型失败被拒绝：%+v", result)
		}
		waitProjectRunEnded(t, p, runID)
		waitRuntimePIDStopped(t, started.PID)
		var count int
		var state string
		var hasDelay bool
		if err := st.pool.QueryRow(context.Background(), `SELECT failure_count,state,COALESCE(next_attempt_at>clock_timestamp(),false) FROM conversations WHERE id=$1`, project.Conversation.ID).Scan(&count, &state, &hasDelay); err != nil || count != failure {
			t.Fatalf("失败次数错误：%d %s %v", count, state, err)
		}
		if failure < 3 {
			if state != "active" || !hasDelay {
				t.Fatalf("未设置失败退避：%s delay=%v", state, hasDelay)
			}
			if _, err := st.pool.Exec(context.Background(), `UPDATE conversations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`, project.Conversation.ID); err != nil {
				t.Fatal(err)
			}
		} else if state != "needs_attention" {
			t.Fatalf("三次失败后状态是 %s", state)
		}
		previous = runID
	}
	time.Sleep(1300 * time.Millisecond)
	var runs int
	if err := st.pool.QueryRow(context.Background(), `SELECT count(*) FROM agent_runs WHERE agent_id=$1`, project.Agent.ID).Scan(&runs); err != nil || runs != 3 {
		t.Fatalf("needs_attention 仍自动启动：%d %v", runs, err)
	}
	var attention inbox.Page
	runtimeProjectHTTP(t, st, "GET", "/api/v1/inbox", nil, &attention, 200)
	if len(attention.Requests) != 1 || attention.Requests[0].Source != "system" || attention.Requests[0].ConditionType != inbox.ProjectNeedsAttention || attention.Requests[0].ActionURL != "/projects/"+project.ID {
		t.Fatalf("重试上限系统事项：%+v", attention)
	}
	attentionID := attention.Requests[0].ID
	var systemInputs int
	if err := st.pool.QueryRow(context.Background(), `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='attention_answer'`, project.Agent.ID).Scan(&systemInputs); err != nil || systemInputs != 0 {
		t.Fatal("系统事项生成输入", systemInputs, err)
	}
	runtimeProjectHTTP(t, st, "POST", "/api/v1/projects/"+project.ID+"/retry", map[string]any{}, nil, 200)
	var resolved inbox.Request
	runtimeProjectHTTP(t, st, "GET", "/api/v1/attention-requests/"+attentionID, nil, &resolved, 200)
	if resolved.State != "resolved" {
		t.Fatal("确认重试未解决系统事项", resolved.State)
	}
	if err := st.pool.QueryRow(context.Background(), `SELECT count(*) FROM project_agent_input_queue WHERE agent_id=$1 AND source_type='attention_answer'`, project.Agent.ID).Scan(&systemInputs); err != nil || systemInputs != 0 {
		t.Fatal("系统解决生成输入", systemInputs, err)
	}
	recovered, _ := waitProjectRun(t, p, project, runID)
	var count int
	var state string
	if err := st.pool.QueryRow(context.Background(), `SELECT failure_count,state FROM conversations WHERE id=$1`, project.Conversation.ID).Scan(&count, &state); err != nil || count != 0 || state != "active" {
		t.Fatalf("重试未清零失败：%d %s %v", count, state, err)
	}
	var claim projectagent.Claim
	if r := p.call(t, recovered, "claim-retried-input", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, &claim); !r.OK || claim.InputCount != 1 {
		t.Fatalf("重试丢失原队列输入：%+v %+v", r, claim)
	}
	p.send(t, recovered, "finish-retry", protocol.ProjectRuntimeRequest{Operation: "finish", Reason: "idle"})
	waitProjectRunEnded(t, p, recovered)
	t.Log("真实进程三次模型失败后仅一系统事项、确认重试已解决、无 attention_answer；退避及保留原输入通过")
}

func TestProjectRuntimeRealProcessesDisconnectDeadline(t *testing.T) {
	p := startProjectRuntimeStack(t)
	st := p.stack
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "disconnect")
	runID, _ := waitProjectRun(t, p, project, "")
	started := p.waitRecord(t, runID, "start")
	if r := p.call(t, runID, "claim-disconnect", protocol.ProjectRuntimeRequest{Operation: "claim_inputs"}, nil); !r.OK {
		t.Fatalf("断联前领取失败：%+v", r)
	}
	disconnected := time.Now()
	st.coord.stop()
	// 真实续租间隔与停止期限保持默认值，验证无法连接中心时 batond 自行停止子进程。
	deadline := time.Now().Add(65 * time.Second)
	for time.Now().Before(deadline) && processAlive(started.PID) == nil {
		time.Sleep(100 * time.Millisecond)
	}
	elapsed := time.Since(disconnected)
	if processAlive(started.PID) == nil {
		t.Fatalf("断联 %s 后 Runtime 仍然存活；节点：%s", elapsed, st.batond.out.String())
	}
	if elapsed < 55*time.Second || elapsed > 63*time.Second {
		t.Fatalf("真实断联自停耗时 %s，预期最后一次续租后约58秒", elapsed)
	}
	t.Logf("真实 Coordinator 断联后 batond 在 %s 自行停止 Runtime；未修改20秒续租与58秒停止期限", elapsed.Round(time.Millisecond))
}

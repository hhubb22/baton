package gateway_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestProjectCompactionRealProcesses(t *testing.T) {
	if os.Getenv("BATON_TEST_NODE_PROJECT_RUNTIME") != "1" {
		t.Skip("需安装 Runtime 依赖并显式启用真实 Node 集成验证")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", binary, "./testdata/node_project_runtime.go").CombinedOutput(); err != nil {
		t.Fatalf("构建 Node 启动器: %v %s", err, out)
	}
	st := startPrepareStack(t, map[string]string{
		"PATH":                      dir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"BATON_TEST_RUNTIME_NODE":   node,
		"BATON_TEST_RUNTIME_LOADER": filepath.Join(root, "runtimes/project-agent/node_modules/tsx/dist/loader.mjs"),
		"BATON_TEST_RUNTIME_WORKER": filepath.Join(root, "runtimes/project-agent/test/compaction-worker.ts"),
	})
	waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime != nil })
	p := &projectRuntimeProbe{stack: st}
	project := createRuntimeProject(t, p)
	ctx := context.Background()
	seq := int64(0)
	add := func(kind string, message any, id any) {
		t.Helper()
		seq++
		payload, _ := json.Marshal(map[string]any{"format": "pi-ai/1", "message": message})
		if _, err := st.pool.Exec(ctx, `INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,tool_call_id,payload) VALUES($1,$2,$3,$4,$5,$6)`, project.Conversation.ID, seq, st.employeeID, kind, id, payload); err != nil {
			t.Fatal(err)
		}
	}
	// 八轮原文包含约 400 KiB 内容，每个工具输出都接近 32 KiB 上限。
	for i := 0; i < 8; i++ {
		add("input", map[string]any{"role": "user", "content": "目标" + strings.Repeat("u", 10000), "timestamp": 0}, nil)
		id := fmt.Sprintf("devices-%d", i)
		add("assistant", map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": id, "name": "devices.list", "arguments": map[string]any{}}}}, nil)
		add("tool_result", map[string]any{"role": "toolResult", "toolCallId": id, "toolName": "devices.list", "content": []any{map[string]any{"type": "text", "text": "原文标记" + strings.Repeat("x", 30000)}}, "isError": false, "timestamp": 0}, id)
		add("assistant", map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": strings.Repeat("a", 10000)}}}, nil)
	}
	if _, err := st.pool.Exec(ctx, `UPDATE conversations SET next_seq=$2 WHERE id=$1`, project.Conversation.ID, seq+1); err != nil {
		t.Fatal(err)
	}
	messageRuntimeProject(t, p, project, "compaction-input")
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var compactions, reads, searches, finished int
		err = st.pool.QueryRow(ctx, `SELECT
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='compaction' AND (payload->>'through_seq')::bigint>0),
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result' AND tool_call_id='read-original' AND payload::text LIKE '%原文标记%'),
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result' AND tool_call_id='search-original' AND payload::text LIKE '%原文标记%'),
   (SELECT count(*) FROM agent_runs WHERE agent_id=$2 AND state='finished')`, project.Conversation.ID, project.Agent.ID).Scan(&compactions, &reads, &searches, &finished)
		if err != nil {
			t.Fatal(err)
		}
		if compactions > 0 && reads == 1 && searches == 1 && finished == 1 {
			var intact bool
			if err = st.pool.QueryRow(ctx, `SELECT payload::text LIKE '%原文标记%' FROM conversation_events WHERE conversation_id=$1 AND seq=3`, project.Conversation.ID).Scan(&intact); err != nil || !intact {
				t.Fatal("原文被修改", err)
			}
			t.Log("真实 Node Runtime、batond、Gateway、Coordinator 与 PostgreSQL：超长工具输出、多轮摘要、history.read/search 原文恢复通过")
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("压缩进程未完成：Coordinator=%s batond=%s", st.coord.out.String(), st.batond.out.String())
}

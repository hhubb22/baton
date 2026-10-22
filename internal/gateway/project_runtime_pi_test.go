package gateway_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestProjectRuntimePiFauxRealCoordinator(t *testing.T) {
	t.Parallel()
	required := os.Getenv("BATON_TEST_NODE_PROJECT_RUNTIME") == "1"
	if os.Getenv("BATON_TEST_NODE_PROJECT_RUNTIME") == "0" {
		t.Skip("已显式关闭真实 Node Runtime 验证")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		if required {
			t.Fatal("CI 真实 Runtime 验证需要 Node.js", err)
		}
		t.Skip("本机缺少 Node.js，跳过真实 Runtime 验证")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	loader := filepath.Join(root, "runtimes/project-agent/node_modules/tsx/dist/loader.mjs")
	if _, err := os.Stat(loader); err != nil {
		if required {
			t.Fatal("CI 真实 Runtime 验证需要本地 Runtime 依赖", err)
		}
		t.Skip("本机缺少 Runtime 依赖，跳过真实 Runtime 验证")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "baton-project-runtime")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", binary, "./testdata/node_project_runtime.go").CombinedOutput(); err != nil {
		t.Fatalf("构建 Node 启动器: %v %s", err, out)
	}
	st := startProjectStack(t, map[string]string{
		"PATH":                      dir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"BATON_TEST_RUNTIME_NODE":   node,
		"BATON_TEST_RUNTIME_LOADER": loader,
		"BATON_TEST_RUNTIME_WORKER": filepath.Join(root, "runtimes/project-agent/test/integration-worker.ts"),
	})
	waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime != nil })
	p := &projectRuntimeProbe{stack: st}
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "pi-faux-input")
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var assistants, results, memories, finished, compactions int
		err = st.pool.QueryRow(context.Background(), `SELECT
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='assistant'),
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result'),
   (SELECT count(*) FROM project_memory_entries WHERE project_id=$2),
   (SELECT count(*) FROM agent_runs WHERE agent_id=$3 AND state='finished'),
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='compaction')`, project.Conversation.ID, project.ID, project.Agent.ID).Scan(&assistants, &results, &memories, &finished, &compactions)
		if err != nil {
			t.Fatal(err)
		}
		if assistants == 2 && results == 1 && memories == 1 && finished == 1 && compactions == 1 {
			var through, pointer, originalBytes int64
			if err = st.pool.QueryRow(context.Background(), `SELECT c.compaction_seq,(e.payload->>'through_seq')::bigint,
 (SELECT octet_length(payload::text) FROM conversation_events WHERE conversation_id=c.id AND seq=2)
 FROM conversations c JOIN conversation_events e ON e.conversation_id=c.id AND e.seq=c.compaction_seq WHERE c.id=$1`, project.Conversation.ID).Scan(&pointer, &through, &originalBytes); err != nil {
				t.Fatal(err)
			}
			if pointer != 5 || through != 3 || originalBytes < 50000 {
				t.Fatalf("压缩位置或原文无效: %d %d %d", pointer, through, originalBytes)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("真实 Runtime 未完成写入屏障、工具事务、压缩与 finish：Coordinator=%s batond=%s", st.coord.out.String(), st.batond.out.String())
}

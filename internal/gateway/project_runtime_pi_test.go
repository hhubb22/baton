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
		"BATON_TEST_RUNTIME_WORKER": filepath.Join(root, "runtimes/project-agent/test/integration-worker.ts"),
	})
	waitRuntimeReport(t, st, func(r protocol.RuntimeReport) bool { return r.ProjectRuntime != nil })
	p := &projectRuntimeProbe{stack: st}
	project := createRuntimeProject(t, p)
	messageRuntimeProject(t, p, project, "pi-faux-input")
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var assistants, results, memories, finished int
		err = st.pool.QueryRow(context.Background(), `SELECT
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='assistant'),
   (SELECT count(*) FROM conversation_events WHERE conversation_id=$1 AND kind='tool_result'),
   (SELECT count(*) FROM project_memory_entries WHERE project_id=$2),
   (SELECT count(*) FROM agent_runs WHERE agent_id=$3 AND state='finished')`, project.Conversation.ID, project.ID, project.Agent.ID).Scan(&assistants, &results, &memories, &finished)
		if err != nil {
			t.Fatal(err)
		}
		if assistants == 2 && results == 1 && memories == 1 && finished == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("真实 Runtime 未完成写入屏障、工具事务与 finish：Coordinator=%s batond=%s", st.coord.out.String(), st.batond.out.String())
}

package node

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"baton/internal/agentcli"
	"baton/internal/privatefile"
	"baton/internal/privatefiletest"
	"baton/internal/session"
	"baton/internal/task"
)

func TestAgentContextBindsAndSurvivesRestart(t *testing.T) {
	ledger := openTestLedger(t)
	report := ledger.Prepare(samplePrepare(t), nil)
	if !report.OK {
		t.Fatal("没有准备映射")
	}
	dir, err := session.SessionDir(ledger.dir, report.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ledger.ensureAgentContext(report); err != nil {
		t.Fatal(err)
	}
	path, err := session.AgentContextPath(ledger.dir, report.SessionID, report.ExecutionID)
	if err != nil {
		t.Fatal(err)
	}
	privatefiletest.AssertPrivate(t, path)
	var first agentcli.Context
	if err := agentcli.ReadFile(path, &first); err != nil {
		t.Fatal(err)
	}
	binding, err := ledger.agentBinding(first.Token)
	if err != nil || binding.SourceTaskID != report.TaskID || binding.SourceSessionID != report.SessionID || binding.SourceExecutionID != report.ExecutionID {
		t.Fatal("来源不是持久化绑定")
	}
	if err := ledger.ensureAgentContext(report); err != nil {
		t.Fatal(err)
	}
	var again agentcli.Context
	if err := agentcli.ReadFile(path, &again); err != nil || again.Token != first.Token {
		t.Fatal("重复准备更换了上下文")
	}
	reopened, err := OpenLedger(ledger.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.agentBinding(first.Token); err != nil {
		t.Fatal("重开账本丢失绑定")
	}
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ledger.ensureAgentContext(report); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.agentBinding(first.Token); err == nil {
		t.Fatal("轮换后旧令牌仍有效")
	}
	if err := agentcli.ReadFile(path, &again); err != nil {
		t.Fatal(err)
	}
	closeIPC, err := serveAgentIPC(context.Background(), ledger, &agentBridge{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeIPC()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	got, err := agentcli.Call(ctx, path, agentcli.Request{Operation: "get", TaskID: report.TaskID})
	if err != nil || got.OK || got.Code != task.CodeUnavailable {
		t.Fatalf("断线没有明确失败: %+v %v", got, err)
	}
	bad := filepath.Join(dir, "forged.json")
	data, err := json.Marshal(agentcli.Context{Endpoint: again.Endpoint, Token: first.Token})
	if err != nil {
		t.Fatal(err)
	}
	if err := privatefile.WriteFile(bad, data); err != nil {
		t.Fatal(err)
	}
	got, err = agentcli.Call(ctx, bad, agentcli.Request{Operation: "get", TaskID: report.TaskID})
	if err != nil || got.Code != task.CodeForbidden {
		t.Fatalf("旧凭据未被拒绝: %+v %v", got, err)
	}
}

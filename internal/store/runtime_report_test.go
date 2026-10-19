package store_test

import (
	"context"
	"errors"
	"testing"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
)

func TestRuntimeReportOwnershipConnectionAndIdempotency(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	ident := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"codex"})
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: alice.ID, NodeID: ident.NodeID, CredentialID: ident.Credential.ID, Incarnation: mustID(t), ConnID: mustID(t)}
	if err := repo.ConnectNode(ctx, src); err != nil {
		t.Fatal(err)
	}
	report := protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{}, Repos: []protocol.RuntimeRepo{}}
	if _, err := repo.SaveRuntimeReport(ctx, src, report); !errors.Is(err, store.ErrSyncRejected) {
		t.Fatal("未同步连接可写报告")
	}
	if err := repo.SyncNode(ctx, alice.ID, ident.NodeID, src.ConnID, "Desk", node.SystemLinux, "", []string{"codex"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if v, err := repo.SaveRuntimeReport(ctx, src, report); err != nil || v != 1 {
			t.Fatalf("重复报告未保持版本：%d %v", v, err)
		}
	}
	report.Exec.Enabled = true
	if v, err := repo.SaveRuntimeReport(ctx, src, report); err != nil || v != 2 {
		t.Fatalf("报告变化未增加版本：%d %v", v, err)
	}
	for _, invalid := range []protocol.Source{
		{EmployeeID: bob.ID, NodeID: ident.NodeID, CredentialID: ident.Credential.ID, ConnID: src.ConnID},
		{EmployeeID: alice.ID, NodeID: ident.NodeID, CredentialID: ident.Credential.ID, ConnID: mustID(t)},
		{EmployeeID: alice.ID, NodeID: ident.NodeID, CredentialID: mustID(t), ConnID: src.ConnID},
	} {
		if _, err := repo.SaveRuntimeReport(ctx, invalid, report); !errors.Is(err, store.ErrSyncRejected) {
			t.Fatalf("非当前身份可写报告：%v", err)
		}
	}
	view := mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if len(view.Capabilities) != 1 || view.Capabilities[0] != "codex" || !view.Executable() {
		t.Fatal("报告改变了执行 Agent 能力")
	}
	old := src
	src.ConnID = mustID(t)
	if err := repo.ConnectNode(ctx, src); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SaveRuntimeReport(ctx, old, report); !errors.Is(err, store.ErrSyncRejected) {
		t.Fatal("重连后旧连接覆盖报告")
	}
	if err := repo.SyncNode(ctx, alice.ID, ident.NodeID, src.ConnID, "Desk", node.SystemLinux, "", []string{"codex"}); err != nil {
		t.Fatal(err)
	}
	if v, err := repo.SaveRuntimeReport(ctx, src, report); err != nil || v != 2 {
		t.Fatalf("重连重发未幂等：%d %v", v, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE node_credentials SET revoked_at=now() WHERE id=$1::uuid`, src.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SaveRuntimeReport(ctx, src, report); !errors.Is(err, store.ErrSyncRejected) {
		t.Fatal("吊销凭据后仍可写报告")
	}
}

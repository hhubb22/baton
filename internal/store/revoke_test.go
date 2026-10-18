package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRevokeKeepsHistoryAndInvalidDefault(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	desk := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"start"})
	if defaultPC(t, ctx, pool, alice.ID) != desk.NodeID {
		t.Fatal("首个 PC 没有成为默认节点")
	}
	conn := mustID(t)
	if err := repo.UpsertPresence(ctx, protocol.Presence{
		NodeID: desk.NodeID, EmployeeID: alice.ID, CredentialID: desk.Credential.ID,
		Incarnation: mustID(t), ConnID: conn, Online: true, LastContact: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.SyncNode(ctx, alice.ID, desk.NodeID, conn, "Desk", node.SystemLinux, node.RolePC, []string{"start"}); err != nil {
		t.Fatal(err)
	}

	if _, err := repo.RevokeNode(ctx, bob.ID, desk.NodeID); !errors.Is(err, store.ErrRevokeRejected) {
		t.Fatalf("其他员工吊销得到 %v", err)
	}
	if _, err := repo.RevokeNode(ctx, alice.ID, bob.ID); !errors.Is(err, store.ErrRevokeRejected) {
		t.Fatalf("不存在的节点得到 %v", err)
	}
	if countRows(t, ctx, pool, `SELECT COUNT(*) FROM node_revocations`) != 0 || defaultPC(t, ctx, pool, alice.ID) != desk.NodeID {
		t.Fatal("被拒绝的吊销写入了记录或改了默认设备")
	}

	decision, err := repo.RevokeNode(ctx, alice.ID, desk.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	if decision.Status != store.RevocationPending || decision.OperatorID != alice.ID || decision.AppliedAt != nil {
		t.Fatalf("保存后不应显示已生效: %+v", decision)
	}
	if len(decision.CredentialIDs) != 1 || decision.CredentialIDs[0] != desk.Credential.ID || decision.RequestedAt.IsZero() {
		t.Fatalf("吊销记录缺少操作者或凭据: %+v", decision)
	}
	creds, revokedNodes, err := repo.Revocations(ctx)
	if err != nil || len(creds) != 1 || creds[0].ID != desk.Credential.ID || len(revokedNodes) != 1 || revokedNodes[0].ID != desk.NodeID {
		t.Fatalf("快照没有包含已保存的吊销: %+v %+v %v", creds, revokedNodes, err)
	}
	view := mustOwn(t, ctx, repo, alice.ID, desk.NodeID)
	if view.RevocationStatus != store.RevocationPending || view.Executable() || !view.Revoked {
		t.Fatalf("处理中的节点仍可执行或已显示生效: %+v", view)
	}
	if err := repo.SyncNode(ctx, alice.ID, desk.NodeID, conn, "Desk", node.SystemLinux, node.RolePC, []string{"start"}); !errors.Is(err, store.ErrSyncRejected) {
		t.Fatalf("吊销决定保存后仍接受同步: %v", err)
	}
	if _, err := repo.SetDefaultDevice(ctx, alice.ID, desk.NodeID); !errors.Is(err, store.ErrNodeInactive) {
		t.Fatalf("被吊销节点仍可设为默认设备: %v", err)
	}

	again, err := repo.RevokeNode(ctx, alice.ID, desk.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	if !again.RequestedAt.Equal(decision.RequestedAt) || again.OperatorID != alice.ID || countRows(t, ctx, pool, `SELECT COUNT(*) FROM node_revocations`) != 1 {
		t.Fatal("重复吊销改写了原记录")
	}

	later := mustRegister(t, ctx, pool, repo, alice.ID, "Later", node.RolePC, []string{"start"})
	if defaultPC(t, ctx, pool, alice.ID) != desk.NodeID || later.NodeID == desk.NodeID {
		t.Fatal("吊销后的新节点被自动选成了默认设备")
	}
	state, err := repo.DefaultDeviceState(ctx, alice.ID)
	if err != nil || state.NodeID != desk.NodeID || state.Status != store.RevocationPending {
		t.Fatalf("默认设备引用没有保留: %+v %v", state, err)
	}

	if err := repo.MarkRevocationsApplied(ctx, decision.CredentialIDs); err != nil {
		t.Fatal(err)
	}
	effective, err := repo.NodeRevocation(ctx, alice.ID, desk.NodeID)
	if err != nil || effective.Status != store.RevocationEffective || effective.AppliedAt == nil {
		t.Fatalf("回执后没有变为已生效: %+v %v", effective, err)
	}
	if countRows(t, ctx, pool, `SELECT COUNT(*) FROM nodes WHERE employee_id = $1::uuid`, alice.ID) != 2 {
		t.Fatal("吊销删除了节点")
	}
	if countRows(t, ctx, pool, `SELECT COUNT(*) FROM node_credentials WHERE node_id = $1::uuid`, desk.NodeID) != 1 {
		t.Fatal("吊销删除了凭据")
	}
	if countRows(t, ctx, pool, `SELECT COUNT(*) FROM node_credentials WHERE id = $1::uuid AND revoked_at IS NOT NULL`, desk.Credential.ID) != 1 {
		t.Fatal("凭据行没有保留吊销时间")
	}
	if defaultPC(t, ctx, pool, alice.ID) != desk.NodeID {
		t.Fatal("回执后默认设备被改掉了")
	}
}

func countRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

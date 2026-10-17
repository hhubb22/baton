package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
)

func TestPresenceKeepsSyncForTheSameConnection(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	bob := mustEmployee(t, ctx, pool, "bob", "Bob")
	ident := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"start"})
	other := mustRegister(t, ctx, pool, repo, bob.ID, "Other", node.RolePC, nil)
	inc := mustID(t)
	conn := mustID(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	presence := protocol.Presence{
		NodeID: ident.NodeID, EmployeeID: alice.ID, CredentialID: ident.Credential.ID,
		Incarnation: inc, ConnID: conn, Online: true, LastContact: now,
	}
	if err := repo.UpsertPresence(ctx, presence); err != nil {
		t.Fatal(err)
	}
	view := mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if !view.Online || view.Synced || view.Executable() || view.LastContact == nil || view.StatusUpdated == nil {
		t.Fatalf("同步前的状态不正确: %+v", view)
	}
	if err := repo.SyncNode(ctx, alice.ID, ident.NodeID, conn, "Desk", node.SystemLinux, node.RolePC, []string{"start"}); err != nil {
		t.Fatal(err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if !view.Executable() {
		t.Fatal("同步完成后仍不可执行")
	}
	statusAt := *view.StatusUpdated
	presence.LastContact = now.Add(time.Second)
	if err := repo.UpsertPresence(ctx, presence); err != nil {
		t.Fatal(err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if !view.Synced || !view.StatusUpdated.Equal(statusAt) {
		t.Fatal("同一连接的重复上报清除了同步或状态时间")
	}
	next := mustID(t)
	presence.ConnID = next
	if err := repo.UpsertPresence(ctx, presence); err != nil {
		t.Fatal(err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if view.Synced || view.Executable() || !view.Online {
		t.Fatal("新连接在同步前显示为可执行")
	}
	if err := repo.MarkOffline(ctx, ident.NodeID, conn, time.Now()); err != nil {
		t.Fatal(err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if !view.Online {
		t.Fatal("旧连接把新连接标成了离线")
	}
	if err := repo.MarkOffline(ctx, ident.NodeID, next, time.Now()); err != nil {
		t.Fatal(err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if view.Online || view.Executable() {
		t.Fatal("当前连接关闭后仍显示在线")
	}
	if _, err := repo.OwnNode(ctx, alice.ID, other.NodeID); err == nil {
		t.Fatal("员工能查看其他人的节点")
	}
	listed, err := repo.ListNodes(ctx, alice.ID)
	if err != nil || len(listed) != 1 || listed[0].ID != ident.NodeID {
		t.Fatalf("节点列表不正确: %+v %v", listed, err)
	}
	if _, err := repo.OwnNode(ctx, bob.ID, ident.NodeID); err == nil {
		t.Fatal("缺少节点和不属于本人的节点被区分开了")
	}

	if err := repo.UpsertPresence(ctx, protocol.Presence{
		NodeID: other.NodeID, EmployeeID: bob.ID, CredentialID: other.Credential.ID,
		Incarnation: mustID(t), ConnID: mustID(t), Online: true, LastContact: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ApplySessions(ctx, []protocol.Presence{presence}); err != nil {
		t.Fatal(err)
	}
	if mustOwn(t, ctx, repo, bob.ID, other.NodeID).Online {
		t.Fatal("不在会话列表中的节点仍在线")
	}
	if err := repo.ApplySessions(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if mustOwn(t, ctx, repo, alice.ID, ident.NodeID).Online {
		t.Fatal("空会话列表没有把节点标离线")
	}
	creds, nodes, err := repo.Revocations(ctx)
	if err != nil || len(creds) != 0 || len(nodes) != 0 {
		t.Fatal("没有吊销记录时快照不为空")
	}
	if _, err := pool.Exec(ctx, `UPDATE node_credentials SET revoked_at = now() WHERE id = $1::uuid`, ident.Credential.ID); err != nil {
		t.Fatal(err)
	}
	creds, _, err = repo.Revocations(ctx)
	if err != nil || len(creds) != 1 || creds[0].ID != ident.Credential.ID || creds[0].Kind != "credential" {
		t.Fatalf("吊销快照不正确: %+v %v", creds, err)
	}
}

func TestSyncRejectsChangingDefaultPCIntoUbuntu(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := store.New(pool)
	alice := mustEmployee(t, ctx, pool, "alice", "Alice")
	ident := mustRegister(t, ctx, pool, repo, alice.ID, "Desk", node.RolePC, []string{"start"})
	if defaultPC(t, ctx, pool, alice.ID) != ident.NodeID {
		t.Fatal("首个 PC 没有成为默认节点")
	}
	conn := mustID(t)
	if err := repo.UpsertPresence(ctx, protocol.Presence{
		NodeID: ident.NodeID, EmployeeID: alice.ID, CredentialID: ident.Credential.ID,
		Incarnation: mustID(t), ConnID: conn, Online: true, LastContact: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	err := repo.SyncNode(ctx, alice.ID, ident.NodeID, conn, "Renamed", node.SystemLinux, node.RoleUbuntu, []string{"build"})
	if !errors.Is(err, store.ErrSyncRejected) {
		t.Fatalf("把默认 PC 同步成 ubuntu 未被拒绝: %v", err)
	}
	view := mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if view.Synced || view.Executable() || view.Role != node.RolePC || view.System != node.SystemLinux || view.DisplayName != "Desk" || len(view.Capabilities) != 1 || view.Capabilities[0] != "start" {
		t.Fatalf("被拒绝的同步改写了身份或标成了已同步: %+v", view)
	}
	if defaultPC(t, ctx, pool, alice.ID) != ident.NodeID {
		t.Fatal("被拒绝的同步改动了默认 PC")
	}
	err = repo.SyncNode(ctx, alice.ID, ident.NodeID, conn, "Renamed", node.SystemWindows, node.RolePC, []string{"build"})
	if !errors.Is(err, store.ErrSyncRejected) {
		t.Fatalf("系统与注册值不一致时未被拒绝: %v", err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if view.Synced || view.System != node.SystemLinux || view.Role != node.RolePC || defaultPC(t, ctx, pool, alice.ID) != ident.NodeID {
		t.Fatalf("系统不一致的同步改写了身份或默认 PC: %+v", view)
	}
	if err := repo.SyncNode(ctx, alice.ID, ident.NodeID, conn, "Renamed", node.SystemLinux, node.RolePC, []string{"start", "files"}); err != nil {
		t.Fatal(err)
	}
	view = mustOwn(t, ctx, repo, alice.ID, ident.NodeID)
	if !view.Synced || view.DisplayName != "Renamed" || view.Role != node.RolePC || view.System != node.SystemLinux || len(view.Capabilities) != 2 || view.Capabilities[0] != "start" || view.Capabilities[1] != "files" {
		t.Fatalf("一致的同步没有只更新显示名和能力: %+v", view)
	}
	if defaultPC(t, ctx, pool, alice.ID) != ident.NodeID {
		t.Fatal("更新显示名后默认 PC 变了")
	}
}

func mustOwn(t *testing.T, ctx context.Context, repo *store.Store, employeeID, nodeID string) store.NodeView {
	t.Helper()
	view, err := repo.OwnNode(ctx, employeeID, nodeID)
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func mustID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

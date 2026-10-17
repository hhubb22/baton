package relay_test

import (
	"context"
	"crypto/x509"
	"net/http/httptest"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/control"
	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/relay"
	"baton/internal/store"
)

func TestRevokeStaysPendingUntilRelayApplies(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	alice, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "revoke-relay-password1")
	if err != nil {
		t.Fatal(err)
	}
	desk := registerNode(t, ctx, repo, signer, alice.ID, "Desk")
	other := registerNode(t, ctx, repo, signer, alice.ID, "Other")
	ctrl, addr, roots := startControlledRelay(t, repo, signer)

	decision, err := repo.RevokeNode(ctx, alice.ID, desk.NodeID)
	if err != nil || decision.Status != store.RevocationPending {
		t.Fatalf("保存后的状态不正确: %+v %v", decision, err)
	}
	stale := dialResult(t, addr, desk.Credential.Token, newID(t), roots)
	if !stale.OK {
		t.Fatal("Relay 还在使用旧快照时，未确认的吊销被当成已经生效")
	}
	still, err := repo.NodeRevocation(ctx, alice.ID, desk.NodeID)
	if err != nil || still.Status != store.RevocationPending {
		t.Fatalf("凭据仍能连入时显示了已生效: %+v %v", still, err)
	}

	waitCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := ctrl.DispatchRevocations(waitCtx); err != nil {
		t.Fatal(err)
	}
	effective, err := repo.NodeRevocation(ctx, alice.ID, desk.NodeID)
	if err != nil || effective.Status != store.RevocationEffective || effective.AppliedAt == nil {
		t.Fatalf("补发回执后没有生效: %+v %v", effective, err)
	}
	if result := dialResult(t, addr, desk.Credential.Token, newID(t), roots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("已生效的凭据仍能连接: %+v", result)
	}
	if result := dialResult(t, addr, other.Credential.Token, newID(t), roots); !result.OK {
		t.Fatalf("其他节点被吊销波及: %+v", result)
	}
	_ = pool
}

func TestSnapshotReconnectDropsStaleCredential(t *testing.T) {
	pool := dbtest.Open(t)
	ctx := context.Background()
	repo := store.New(pool)
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	alice, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "revoke-snap-password01")
	if err != nil {
		t.Fatal(err)
	}
	desk := registerNode(t, ctx, repo, signer, alice.ID, "Desk")
	ctrl, addr, roots := startControlledRelay(t, repo, signer)
	if _, err := repo.RevokeNode(ctx, alice.ID, desk.NodeID); err != nil {
		t.Fatal(err)
	}
	live, result := dialPeer(t, addr, desk.Credential.Token, newID(t), roots)
	if !result.OK {
		t.Fatal("重连前的旧内存拒绝了尚未确认的凭据")
	}
	ctrl.Disconnect()
	waitRevocation(t, repo, alice.ID, desk.NodeID, store.RevocationEffective)
	live.waitClosed(t)
	if result := dialResult(t, addr, desk.Credential.Token, newID(t), roots); result.OK || result.Code != protocol.CodeInvalidCredential {
		t.Fatalf("快照重连后仍放行了同一凭据: %+v", result)
	}
	_ = pool
}

func startControlledRelay(t *testing.T, repo *store.Store, signer node.Signer) (*control.Server, string, *x509.CertPool) {
	t.Helper()
	ctrl, err := control.New(repo, signer, "revoke-control-token-01", 10*time.Second, 30*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(ctrl)
	srv.StartTLS()
	t.Cleanup(srv.Close)
	certFile, keyFile, cert := writeServerCert(t, t.TempDir())
	controlRoots := x509.NewCertPool()
	controlRoots.AddCert(srv.Certificate())
	nodeRoots := x509.NewCertPool()
	nodeRoots.AddCert(cert)
	server, err := relay.New(relay.Options{
		ListenAddr:     "127.0.0.1:0",
		CoordinatorURL: srv.URL,
		ControlToken:   "revoke-control-token-01",
		CertFile:       certFile,
		KeyFile:        keyFile,
		RootCAs:        controlRoots,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go server.Run(runCtx)
	return ctrl, waitAddr(t, server), nodeRoots
}

func (p *peer) waitClosed(t *testing.T) {
	t.Helper()
	deadline := time.After(8 * time.Second)
	for {
		select {
		case _, ok := <-p.frames:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("吊销后连接没有断开")
			return
		}
	}
}

func waitRevocation(t *testing.T, repo *store.Store, employeeID, nodeID, status string) store.RevocationView {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	var last store.RevocationView
	for time.Now().Before(deadline) {
		view, err := repo.NodeRevocation(context.Background(), employeeID, nodeID)
		if err == nil {
			last = view
			if view.Status == status {
				return view
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("吊销状态没有变成 %s: %+v", status, last)
	return last
}

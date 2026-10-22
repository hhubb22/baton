package control

import (
	"baton/internal/admin"
	"baton/internal/dbtest"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

type threadControl struct {
	t      *testing.T
	pool   *pgxpool.Pool
	repo   *store.Store
	server *Server
	signer node.Signer
	owner  string
}

func newThreadControl(t *testing.T) *threadControl {
	t.Helper()
	pool := dbtest.Open(t)
	repo := store.New(pool)
	emp, err := admin.CreateLocal(t.Context(), pool, "thread-control", "Thread", "thread-control-password")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := node.GenerateSigner()
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(repo, signer, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &threadControl{t: t, pool: pool, repo: repo, server: s, signer: signer, owner: emp.ID}
}

func (h *threadControl) addNode(name string) protocol.Source {
	h.t.Helper()
	ctx := h.t.Context()
	_, token, _, err := h.repo.IssueEnrollment(ctx, h.owner, time.Hour)
	if err != nil {
		h.t.Fatal(err)
	}
	ident, err := h.repo.Register(ctx, store.RegisterInput{Token: token, DisplayName: name,
		System: node.SystemLinux, Role: node.RolePC, Capabilities: []string{"pi"}, CredentialTTL: time.Hour}, h.signer)
	if err != nil {
		h.t.Fatal(err)
	}
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: h.owner, NodeID: ident.NodeID,
		CredentialID: ident.Credential.ID, ConnID: compatibilityID(h.t), Incarnation: compatibilityID(h.t)}
	if err := h.repo.ConnectNode(ctx, src); err != nil {
		h.t.Fatal(err)
	}
	if err := h.repo.SyncNode(ctx, h.owner, src.NodeID, src.ConnID, name, node.SystemLinux, node.RolePC, []string{"pi"}); err != nil {
		h.t.Fatal(err)
	}
	return src
}

type threadSender struct {
	send func(context.Context, string, protocol.Envelope) error
}

func (s threadSender) Send(ctx context.Context, nodeID, _ string, env protocol.Envelope) error {
	return s.send(ctx, nodeID, env)
}
func (threadSender) DisconnectCredential(string) {}

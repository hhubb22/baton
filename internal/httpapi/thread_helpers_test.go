package httpapi_test

import (
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
)

func reportThreadRoot(t *testing.T, pool *pgxpool.Pool, owner string, ident node.Identity) {
	t.Helper()
	src := protocol.Source{Kind: protocol.SourceNode, EmployeeID: owner, NodeID: ident.NodeID, CredentialID: ident.Credential.ID}
	if err := pool.QueryRow(t.Context(), "SELECT conn_id,incarnation FROM node_presence WHERE node_id=$1", ident.NodeID).Scan(&src.ConnID, &src.Incarnation); err != nil {
		t.Fatal(err)
	}
	if err := store.New(pool).SyncNode(t.Context(), owner, ident.NodeID, src.ConnID, ident.DisplayName, ident.System, ident.Role, []string{"pi"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.New(pool).SaveRuntimeReport(t.Context(), src, protocol.RuntimeReport{Exec: protocol.RuntimeExec{Shell: "sh"}, Roots: []protocol.RuntimeRoot{{RootID: "dev", Path: "/src"}}, Agents: []protocol.RuntimeAgent{
		{AgentType: "pi", Version: "1.3.0", Status: "available", Capabilities: protocol.ThreadCapabilities{Create: true, Queue: true, Steer: true, Stop: true, Resume: true, SwitchModel: true}},
	}}); err != nil {
		t.Fatal(err)
	}
}

func createOwnedThread(t *testing.T, pool *pgxpool.Pool, owner string, ident node.Identity) string {
	t.Helper()
	reportThreadRoot(t, pool, owner, ident)
	v, _, err := store.New(pool).CreateThread(t.Context(), owner, store.CreateThreadInput{ClientThreadID: threadHTTPID(t), NodeID: ident.NodeID, AgentType: "pi", WorkingDirectory: "/src/repo", Message: store.ThreadMessageInput{ClientMessageID: threadHTTPID(t), Content: "hello"}})
	if err != nil {
		t.Fatal(err)
	}
	return v.ID
}

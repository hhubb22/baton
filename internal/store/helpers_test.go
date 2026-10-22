package store_test

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/store"

	"github.com/jackc/pgx/v5"
)

func markOnline(t *testing.T, ctx context.Context, repo *store.Store, employeeID string, ident node.Identity) string {
	t.Helper()
	connID := mustUUID(t)
	if err := repo.UpsertPresence(ctx, protocol.Presence{
		NodeID: ident.NodeID, EmployeeID: employeeID, CredentialID: ident.Credential.ID,
		Incarnation: mustUUID(t), ConnID: connID, Online: true, LastContact: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	return connID
}

func mustUUID(t *testing.T) string {
	t.Helper()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func enqueueThreadEndFixture(ctx context.Context, tx pgx.Tx, owner, agentID, key, threadID string) error {
	raw, err := protocol.MarshalJSON(map[string]any{"thread_id": threadID})
	if err != nil {
		return err
	}
	hash := sha256.Sum256(raw)
	_, err = tx.Exec(ctx, `INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash,wake_required) VALUES($1,$2,'turn_ended',$3,$4,$5,true)`, owner, agentID, key, raw, hash[:])
	return err
}

package store

import (
	"baton/internal/identity"
	"baton/internal/protocol"
	"context"
)

// LiveNodeSource 把临时设置绑定到本人当前已同步且未吊销的连接。
func (s *Store) LiveNodeSource(ctx context.Context, employeeID, nodeID string) (protocol.Source, error) {
	var src protocol.Source
	if _, err := identity.ParseUUID(employeeID); err != nil {
		return src, ErrSyncRejected
	}
	if _, err := identity.ParseUUID(nodeID); err != nil {
		return src, ErrSyncRejected
	}
	src.Kind = protocol.SourceNode
	err := s.pool.QueryRow(ctx, `SELECT n.employee_id::text,n.id::text,c.id::text,p.conn_id,p.incarnation FROM nodes n JOIN node_presence p ON p.node_id=n.id AND p.employee_id=n.employee_id JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id WHERE n.employee_id=$1 AND n.id=$2 AND n.revoked_at IS NULL AND p.online AND p.synced AND c.revoked_at IS NULL AND c.expires_at>now() ORDER BY c.created_at DESC LIMIT 1`, employeeID, nodeID).Scan(&src.EmployeeID, &src.NodeID, &src.CredentialID, &src.ConnID, &src.Incarnation)
	return src, err
}

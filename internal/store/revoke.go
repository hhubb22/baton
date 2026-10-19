package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"baton/internal/identity"
	"baton/internal/protocol"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5"
)

const (
	// RevocationNone 表示还没有吊销决定。
	RevocationNone = "none"
	// RevocationPending 表示决定已保存，Gateway 尚未确认应用。
	RevocationPending = "pending"
	// RevocationEffective 表示 Gateway 已确认断开并拒绝该凭据。
	RevocationEffective = "effective"
)

// ErrRevokeRejected 表示节点不存在或不属于该员工。两种情况使用同一个错误。
var ErrRevokeRejected = errors.New("revoke rejected")

// RevocationView 是一次节点吊销的处理状态。AppliedAt 只在 Gateway 确认后才有值。
type RevocationView struct {
	NodeID        string
	Status        string
	OperatorID    string
	CredentialIDs []string
	RequestedAt   time.Time
	AppliedAt     *time.Time
}

// DefaultDeviceState 是员工当前保存的默认设备。吊销后 NodeID 保持原值。
type DefaultDeviceState struct {
	NodeID string
	Status string
}

// RevokeNode 先保存吊销决定。已保存的节点保持原操作者和时间；新出现的未吊销凭据会补记一条记录。
// 不修改 employee_settings，因此默认设备不会自动改到其他节点。
func (s *Store) RevokeNode(ctx context.Context, actorID, nodeID string) (RevocationView, error) {
	var err error
	actorID, err = identity.ParseUUID(actorID)
	if err != nil {
		return RevocationView{}, ErrRevokeRejected
	}
	nodeID, err = identity.ParseUUID(nodeID)
	if err != nil {
		return RevocationView{}, ErrRevokeRejected
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RevocationView{}, fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var already bool
	err = tx.QueryRow(ctx, `
		SELECT revoked_at IS NOT NULL
		FROM nodes
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, nodeID, actorID).Scan(&already)
	if errors.Is(err, pgx.ErrNoRows) {
		return RevocationView{}, ErrRevokeRejected
	}
	if err != nil {
		return RevocationView{}, fmt.Errorf("读取节点失败: %s", redact.Scrub(err.Error()))
	}

	rows, err := tx.Query(ctx, `
		UPDATE node_credentials
		SET revoked_at = now()
		WHERE node_id = $1::uuid AND employee_id = $2::uuid AND revoked_at IS NULL
		RETURNING id::text, revoked_at`, nodeID, actorID)
	if err != nil {
		return RevocationView{}, fmt.Errorf("保存吊销失败: %s", redact.Scrub(err.Error()))
	}
	type freshCredential struct {
		id string
		at time.Time
	}
	var fresh []freshCredential
	for rows.Next() {
		var item freshCredential
		if err := rows.Scan(&item.id, &item.at); err != nil {
			rows.Close()
			return RevocationView{}, fmt.Errorf("保存吊销失败: %s", redact.Scrub(err.Error()))
		}
		fresh = append(fresh, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RevocationView{}, fmt.Errorf("保存吊销失败: %s", redact.Scrub(err.Error()))
	}
	rows.Close()

	if len(fresh) == 0 {
		if !already {
			return RevocationView{}, fmt.Errorf("节点没有可吊销的连接凭据")
		}
		if err := tx.Commit(ctx); err != nil {
			return RevocationView{}, fmt.Errorf("提交吊销失败: %s", redact.Scrub(err.Error()))
		}
		return s.NodeRevocation(ctx, actorID, nodeID)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE nodes
		SET revoked_at = COALESCE(revoked_at, $3)
		WHERE id = $1::uuid AND employee_id = $2::uuid`, nodeID, actorID, fresh[0].at); err != nil {
		return RevocationView{}, fmt.Errorf("保存吊销失败: %s", redact.Scrub(err.Error()))
	}
	for _, item := range fresh {
		eventID, err := identity.NewUUID()
		if err != nil {
			return RevocationView{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO node_revocations (
				id, node_id, employee_id, actor_employee_id, credential_id, requested_at
			) VALUES (
				$1::uuid, $2::uuid, $3::uuid, $3::uuid, $4::uuid, $5
			)`, eventID, nodeID, actorID, item.id, item.at); err != nil {
			return RevocationView{}, fmt.Errorf("保存吊销失败: %s", redact.Scrub(err.Error()))
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return RevocationView{}, fmt.Errorf("提交吊销失败: %s", redact.Scrub(err.Error()))
	}
	return s.NodeRevocation(ctx, actorID, nodeID)
}

// NodeRevocation 返回本人节点的吊销状态。不是本人的节点与不存在的节点用同一个错误表示。
func (s *Store) NodeRevocation(ctx context.Context, employeeID, nodeID string) (RevocationView, error) {
	view, err := s.OwnNode(ctx, employeeID, nodeID)
	if err != nil {
		if errors.Is(err, ErrSyncRejected) {
			return RevocationView{}, ErrRevokeRejected
		}
		return RevocationView{}, err
	}
	out := RevocationView{
		NodeID:        view.ID,
		Status:        view.RevocationStatus,
		OperatorID:    view.RevokedBy,
		CredentialIDs: view.RevokedCredentialIDs,
	}
	if out.Status == "" {
		out.Status = RevocationNone
	}
	if view.RevocationRequested != nil {
		out.RequestedAt = *view.RevocationRequested
	}
	if view.RevocationStatus == RevocationEffective {
		out.AppliedAt = view.RevocationApplied
	}
	if out.CredentialIDs == nil {
		out.CredentialIDs = []string{}
	}
	return out, nil
}

// DefaultDeviceState 读取保存的默认设备，不因吊销而改写它。
func (s *Store) DefaultDeviceState(ctx context.Context, employeeID string) (DefaultDeviceState, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return DefaultDeviceState{}, ErrRevokeRejected
	}
	var nodeID string
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(default_device_node_id::text, '')
		FROM employee_settings
		WHERE employee_id = $1::uuid`, employeeID).Scan(&nodeID)
	if errors.Is(err, pgx.ErrNoRows) || nodeID == "" {
		return DefaultDeviceState{Status: RevocationNone}, nil
	}
	if err != nil {
		return DefaultDeviceState{}, fmt.Errorf("读取默认设备失败: %s", redact.Scrub(err.Error()))
	}
	view, err := s.OwnNode(ctx, employeeID, nodeID)
	if err != nil {
		return DefaultDeviceState{}, err
	}
	status := view.RevocationStatus
	if status == "" {
		status = RevocationNone
	}
	return DefaultDeviceState{NodeID: nodeID, Status: status}, nil
}

// PendingRevocationSet 是尚未被 Gateway 确认的吊销，用于进程内应用和启动恢复。
func (s *Store) PendingRevocationSet(ctx context.Context) (creds, nodes []protocol.Revocation, credentialIDs []string, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT credential_id::text, node_id::text, requested_at
		FROM node_revocations
		WHERE applied_at IS NULL
		ORDER BY requested_at, credential_id`)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	creds = []protocol.Revocation{}
	nodes = []protocol.Revocation{}
	credentialIDs = []string{}
	seenNode := map[string]struct{}{}
	for rows.Next() {
		var cred protocol.Revocation
		cred.Kind = "credential"
		if err := rows.Scan(&cred.ID, &cred.NodeID, &cred.RevokedAt); err != nil {
			return nil, nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
		}
		cred.RevokedAt = cred.RevokedAt.UTC()
		creds = append(creds, cred)
		credentialIDs = append(credentialIDs, cred.ID)
		if _, ok := seenNode[cred.NodeID]; ok {
			continue
		}
		seenNode[cred.NodeID] = struct{}{}
		nodes = append(nodes, protocol.Revocation{
			Kind: "node", ID: cred.NodeID, RevokedAt: cred.RevokedAt,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
	}
	return creds, nodes, credentialIDs, nil
}

// MarkRevocationsApplied 只把回执中的凭据标成已生效。没有回执的记录保持处理中。
func (s *Store) MarkRevocationsApplied(ctx context.Context, credentialIDs []string) error {
	if len(credentialIDs) == 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE node_revocations
		SET applied_at = now()
		WHERE applied_at IS NULL AND credential_id::text = ANY($1::text[])`, credentialIDs); err != nil {
		return fmt.Errorf("保存吊销回执失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// RevocationsApplied 报告这批凭据是否都已经有 Gateway 回执。
func (s *Store) RevocationsApplied(ctx context.Context, credentialIDs []string) (bool, error) {
	if len(credentialIDs) == 0 {
		return true, nil
	}
	var n int
	if err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM node_revocations
		WHERE applied_at IS NULL AND credential_id::text = ANY($1::text[])`, credentialIDs).Scan(&n); err != nil {
		return false, fmt.Errorf("读取吊销回执失败: %s", redact.Scrub(err.Error()))
	}
	return n == 0, nil
}

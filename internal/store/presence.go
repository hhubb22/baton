package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/protocol"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5"
)

var ErrSyncRejected = errors.New("sync rejected")

// NodeView 是本人节点的注册信息和连接状态。
type NodeView struct {
	ID                   string
	DisplayName          string
	System               string
	Role                 string
	Capabilities         []string
	RegistrationSeq      int64
	Online               bool
	Synced               bool
	Revoked              bool
	RevocationStatus     string
	RevokedBy            string
	RevocationRequested  *time.Time
	RevocationApplied    *time.Time
	RevokedCredentialIDs []string
	LastContact          *time.Time
	StatusUpdated        *time.Time
}

// Executable 只有在线、已同步且未吊销时为真。
func (v NodeView) Executable() bool {
	return v.Online && v.Synced && !v.Revoked
}

// UpsertPresence 记录一次在线会话。同一 conn_id 的重复报告不清除已完成的同步。
func (s *Store) UpsertPresence(ctx context.Context, p protocol.Presence) error {
	if err := checkPresence(p); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO node_presence (
			node_id, employee_id, online, synced, incarnation, conn_id, last_contact_at, status_updated_at
		) VALUES (
			$1::uuid, $2::uuid, true, false, $3, $4, $5, $6
		)
		ON CONFLICT (node_id) DO UPDATE SET
			employee_id = EXCLUDED.employee_id,
			online = true,
			synced = CASE
				WHEN node_presence.conn_id = EXCLUDED.conn_id THEN node_presence.synced
				ELSE false
			END,
			incarnation = EXCLUDED.incarnation,
			conn_id = EXCLUDED.conn_id,
			last_contact_at = EXCLUDED.last_contact_at,
			status_updated_at = CASE
				WHEN node_presence.conn_id = EXCLUDED.conn_id AND node_presence.online THEN node_presence.status_updated_at
				ELSE EXCLUDED.status_updated_at
			END`,
		p.NodeID, p.EmployeeID, p.Incarnation, p.ConnID, p.LastContact.UTC(), time.Now().UTC())
	if err != nil {
		return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// MarkOffline 只把仍在使用该 conn_id 的会话标为离线。
func (s *Store) MarkOffline(ctx context.Context, nodeID, connID string, at time.Time) error {
	nodeID, err := identity.ParseUUID(nodeID)
	if err != nil || connID == "" {
		return ErrSyncRejected
	}
	if at.IsZero() {
		at = time.Now()
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE node_presence
		SET online = false, synced = false, status_updated_at = $3
		WHERE node_id = $1::uuid AND conn_id = $2 AND online`,
		nodeID, connID, at.UTC())
	if err != nil {
		return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// ApplySessions 用 Relay 的当前连接替换在线集合。不在列表中的在线节点改为离线。
func (s *Store) ApplySessions(ctx context.Context, sessions []protocol.Presence) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ids := make([]string, 0, len(sessions))
	now := time.Now().UTC()
	for _, p := range sessions {
		if err := checkPresence(p); err != nil {
			return err
		}
		if !p.Online {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO node_presence (
				node_id, employee_id, online, synced, incarnation, conn_id, last_contact_at, status_updated_at
			) VALUES (
				$1::uuid, $2::uuid, true, false, $3, $4, $5, $6
			)
			ON CONFLICT (node_id) DO UPDATE SET
				employee_id = EXCLUDED.employee_id,
				online = true,
				synced = CASE
					WHEN node_presence.conn_id = EXCLUDED.conn_id THEN node_presence.synced
					ELSE false
				END,
				incarnation = EXCLUDED.incarnation,
				conn_id = EXCLUDED.conn_id,
				last_contact_at = EXCLUDED.last_contact_at,
				status_updated_at = CASE
					WHEN node_presence.conn_id = EXCLUDED.conn_id AND node_presence.online THEN node_presence.status_updated_at
					ELSE EXCLUDED.status_updated_at
				END`,
			p.NodeID, p.EmployeeID, p.Incarnation, p.ConnID, p.LastContact.UTC(), now); err != nil {
			return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
		}
		ids = append(ids, p.NodeID)
	}
	if len(ids) == 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE node_presence
			SET online = false, synced = false, status_updated_at = $1
			WHERE online`, now); err != nil {
			return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
		}
	} else if _, err := tx.Exec(ctx, `
		UPDATE node_presence
		SET online = false, synced = false, status_updated_at = $2
		WHERE online AND node_id::text <> ALL($1::text[])`, ids, now); err != nil {
		return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("提交节点状态失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// SyncNode 只更新显示名和能力。系统和角色必须与注册时保存的值一致，否则拒绝且不标为已同步。
func (s *Store) SyncNode(ctx context.Context, employeeID, nodeID, connID, displayName, system, role string, capabilities []string) error {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return ErrSyncRejected
	}
	nodeID, err = identity.ParseUUID(nodeID)
	if err != nil {
		return ErrSyncRejected
	}
	if connID == "" {
		return ErrSyncRejected
	}
	if capabilities == nil {
		capabilities = []string{}
	}
	if err := node.Validate(displayName, system, role, capabilities); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var registeredSystem, registeredRole string
	err = tx.QueryRow(ctx, `
		SELECT system_name, role
		FROM nodes
		WHERE id = $1::uuid AND employee_id = $2::uuid AND revoked_at IS NULL
		FOR UPDATE`, nodeID, employeeID).Scan(&registeredSystem, &registeredRole)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (system != registeredSystem || role != registeredRole)) {
		return ErrSyncRejected
	}
	if err != nil {
		return fmt.Errorf("读取节点失败: %s", redact.Scrub(err.Error()))
	}
	tag, err := tx.Exec(ctx, `
		UPDATE nodes
		SET display_name = $1, capabilities = $2
		WHERE id = $3::uuid AND employee_id = $4::uuid AND revoked_at IS NULL
		  AND system_name = $5 AND role = $6`,
		displayName, capabilities, nodeID, employeeID, system, role)
	if err != nil {
		return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return ErrSyncRejected
	}
	tag, err = tx.Exec(ctx, `
		UPDATE node_presence
		SET synced = true, status_updated_at = now()
		WHERE node_id = $1::uuid AND employee_id = $2::uuid AND conn_id = $3 AND online`,
		nodeID, employeeID, connID)
	if err != nil {
		return fmt.Errorf("保存节点状态失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return ErrSyncRejected
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("提交节点状态失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// ListNodes 返回该员工自己的节点。
func (s *Store) ListNodes(ctx context.Context, employeeID string) ([]NodeView, error) {
	employeeID, err := identity.ParseUUID(employeeID)
	if err != nil {
		return nil, ErrSyncRejected
	}
	rows, err := s.pool.Query(ctx, nodeStatusSQL+` WHERE n.employee_id = $1::uuid ORDER BY n.registration_seq`, employeeID)
	if err != nil {
		return nil, fmt.Errorf("读取节点状态失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var out []NodeView
	for rows.Next() {
		view, err := scanNodeView(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, view)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取节点状态失败: %s", redact.Scrub(err.Error()))
	}
	if out == nil {
		out = []NodeView{}
	}
	return out, nil
}

// OwnNode 返回本人的一个节点。不是本人的节点与不存在的节点用同一个错误表示。
func (s *Store) OwnNode(ctx context.Context, employeeID, nodeID string) (NodeView, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return NodeView{}, ErrSyncRejected
	}
	nodeID, err = identity.ParseUUID(nodeID)
	if err != nil {
		return NodeView{}, ErrSyncRejected
	}
	rows, err := s.pool.Query(ctx, nodeStatusSQL+` WHERE n.employee_id = $1::uuid AND n.id = $2::uuid`, employeeID, nodeID)
	if err != nil {
		return NodeView{}, fmt.Errorf("读取节点状态失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return NodeView{}, fmt.Errorf("读取节点状态失败: %s", redact.Scrub(err.Error()))
		}
		return NodeView{}, ErrSyncRejected
	}
	return scanNodeView(rows)
}

const nodeStatusSQL = `
	SELECT n.id::text, n.display_name, n.system_name, n.role, n.capabilities, n.registration_seq,
	       n.revoked_at IS NOT NULL,
	       CASE
	           WHEN n.revoked_at IS NULL THEN 'none'
	           WHEN EXISTS (
	               SELECT 1 FROM node_revocations r
	               WHERE r.node_id = n.id AND r.applied_at IS NULL
	           ) THEN 'pending'
	           WHEN EXISTS (
	               SELECT 1 FROM node_revocations r WHERE r.node_id = n.id
	           ) THEN 'effective'
	           ELSE 'pending'
	       END,
	       COALESCE((
	           SELECT r.actor_employee_id::text
	           FROM node_revocations r
	           WHERE r.node_id = n.id
	           ORDER BY r.requested_at, r.id
	           LIMIT 1
	       ), ''),
	       (
	           SELECT MIN(r.requested_at) FROM node_revocations r WHERE r.node_id = n.id
	       ),
	       (
	           SELECT MAX(r.applied_at) FROM node_revocations r WHERE r.node_id = n.id
	       ),
	       COALESCE((
	           SELECT array_agg(r.credential_id::text ORDER BY r.requested_at, r.credential_id)
	           FROM node_revocations r
	           WHERE r.node_id = n.id
	       ), ARRAY[]::text[]),
	       COALESCE(p.online, false),
	       COALESCE(p.synced, false),
	       p.last_contact_at,
	       p.status_updated_at
	FROM nodes n
	LEFT JOIN node_presence p ON p.node_id = n.id AND p.employee_id = n.employee_id`

func scanNodeView(row pgx.Row) (NodeView, error) {
	var view NodeView
	var caps []string
	var creds []string
	if err := row.Scan(
		&view.ID, &view.DisplayName, &view.System, &view.Role, &caps, &view.RegistrationSeq,
		&view.Revoked, &view.RevocationStatus, &view.RevokedBy, &view.RevocationRequested, &view.RevocationApplied, &creds,
		&view.Online, &view.Synced, &view.LastContact, &view.StatusUpdated,
	); err != nil {
		return NodeView{}, fmt.Errorf("读取节点状态失败: %s", redact.Scrub(err.Error()))
	}
	if caps == nil {
		caps = []string{}
	}
	view.Capabilities = caps
	if creds == nil {
		creds = []string{}
	}
	view.RevokedCredentialIDs = creds
	if view.RevocationStatus != RevocationEffective {
		view.RevocationApplied = nil
	}
	if view.RevocationRequested != nil {
		t := view.RevocationRequested.UTC()
		view.RevocationRequested = &t
	}
	if view.RevocationApplied != nil {
		t := view.RevocationApplied.UTC()
		view.RevocationApplied = &t
	}
	if view.LastContact != nil {
		t := view.LastContact.UTC()
		view.LastContact = &t
	}
	if view.StatusUpdated != nil {
		t := view.StatusUpdated.UTC()
		view.StatusUpdated = &t
	}
	return view, nil
}

// Revocations 读取已经吊销的凭据和节点，供安全快照使用。
func (s *Store) Revocations(ctx context.Context) (creds, nodes []protocol.Revocation, err error) {
	creds = []protocol.Revocation{}
	nodes = []protocol.Revocation{}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, node_id::text, revoked_at
		FROM node_credentials
		WHERE revoked_at IS NOT NULL
		ORDER BY revoked_at, id`)
	if err != nil {
		return nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	for rows.Next() {
		var item protocol.Revocation
		item.Kind = "credential"
		if err := rows.Scan(&item.ID, &item.NodeID, &item.RevokedAt); err != nil {
			return nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
		}
		item.RevokedAt = item.RevokedAt.UTC()
		creds = append(creds, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
	}
	rows.Close()
	rows, err = s.pool.Query(ctx, `
		SELECT id::text, revoked_at
		FROM nodes
		WHERE revoked_at IS NOT NULL
		ORDER BY revoked_at, id`)
	if err != nil {
		return nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	for rows.Next() {
		var item protocol.Revocation
		item.Kind = "node"
		if err := rows.Scan(&item.ID, &item.RevokedAt); err != nil {
			return nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
		}
		item.RevokedAt = item.RevokedAt.UTC()
		nodes = append(nodes, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("读取吊销记录失败: %s", redact.Scrub(err.Error()))
	}
	return creds, nodes, nil
}

func checkPresence(p protocol.Presence) error {
	var err error
	p.NodeID, err = identity.ParseUUID(p.NodeID)
	if err != nil {
		return ErrSyncRejected
	}
	if _, err = identity.ParseUUID(p.EmployeeID); err != nil {
		return ErrSyncRejected
	}
	if _, err = identity.ParseUUID(p.CredentialID); err != nil {
		return ErrSyncRejected
	}
	if _, err = identity.ParseUUID(p.Incarnation); err != nil {
		return ErrSyncRejected
	}
	if _, err = identity.ParseUUID(p.ConnID); err != nil {
		return ErrSyncRejected
	}
	return nil
}

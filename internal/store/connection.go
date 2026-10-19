package store

import (
	"baton/internal/protocol"
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

// CheckNodeConnection 核对数据库凭据和连接代次；业务分派需要已完成同步。
func (s *Store) CheckNodeConnection(ctx context.Context, src protocol.Source, current, synced bool) error {
	var ok bool
	err := s.pool.QueryRow(ctx, `
 SELECT EXISTS (
 SELECT 1 FROM nodes n JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id
 WHERE n.id=$1::uuid AND n.employee_id=$2::uuid AND c.id=$3::uuid
 AND n.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>now()
 AND (NOT $4 OR EXISTS (SELECT 1 FROM node_presence p WHERE p.node_id=n.id AND p.conn_id=$5 AND p.online AND (NOT $6 OR p.synced))))`, src.NodeID, src.EmployeeID, src.CredentialID, current, src.ConnID, synced).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return ErrSyncRejected
	}
	return nil
}

// ConnectNode 与吊销在同一节点行锁上排序，连接登记仍保持 synced=false。
func (s *Store) ConnectNode(ctx context.Context, src protocol.Source) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `SELECT n.id::text FROM nodes n JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id WHERE n.id=$1::uuid AND n.employee_id=$2::uuid AND c.id=$3::uuid AND n.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>now() FOR UPDATE OF n`, src.NodeID, src.EmployeeID, src.CredentialID).Scan(&id)
	if err == pgx.ErrNoRows {
		return ErrSyncRejected
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO node_presence(node_id,employee_id,online,synced,incarnation,conn_id,last_contact_at,status_updated_at) VALUES($1::uuid,$2::uuid,true,false,$3,$4,now(),now()) ON CONFLICT(node_id) DO UPDATE SET online=true,synced=false,incarnation=EXCLUDED.incarnation,conn_id=EXCLUDED.conn_id,last_contact_at=now(),status_updated_at=now()`, src.NodeID, src.EmployeeID, src.Incarnation, src.ConnID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) TouchNode(ctx context.Context, src protocol.Source) error {
	if err := s.CheckNodeConnection(ctx, src, true, false); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE node_presence SET last_contact_at=$3 WHERE node_id=$1::uuid AND conn_id=$2 AND online`, src.NodeID, src.ConnID, time.Now().UTC())
	return err
}

// ResetConnections 清理上一个 Coordinator 进程遗留的在线事实。
func (s *Store) ResetConnections(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `UPDATE node_presence SET online=false,synced=false,status_updated_at=now() WHERE online`)
	return err
}

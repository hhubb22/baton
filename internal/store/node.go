package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"baton/internal/auth"
	"baton/internal/identity"
	"baton/internal/node"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxEnrollmentSeconds = 24 * 3600
	maxCredentialSeconds = 90 * 24 * 3600
)

var (
	ErrEnrollmentInvalid = errors.New("enrollment invalid")
	ErrEnrollmentExpired = errors.New("enrollment expired")
	ErrEnrollmentUsed    = errors.New("enrollment used")
	ErrDefaultRejected   = errors.New("default rejected")
	ErrNotPCNode         = errors.New("not pc node")
	ErrNodeInactive      = errors.New("node inactive")
)

// RegisterInput 是一次节点注册。员工由注册凭据决定，不从这里读取。
type RegisterInput struct {
	Token         string
	DisplayName   string
	System        string
	Role          string
	Capabilities  []string
	CredentialTTL time.Duration
}

// IssueEnrollment 为已登录员工签发一次性注册凭据。数据库只保存摘要。
func (s *Store) IssueEnrollment(ctx context.Context, employeeID string, ttl time.Duration) (id, token string, expires time.Time, err error) {
	if _, err := identity.ParseUUID(employeeID); err != nil {
		return "", "", time.Time{}, errors.New("员工标识不正确")
	}
	seconds, err := positiveSeconds(ttl, maxEnrollmentSeconds)
	if err != nil {
		return "", "", time.Time{}, errors.New("注册凭据有效期无效")
	}
	token, err = auth.NewSecret()
	if err != nil {
		return "", "", time.Time{}, err
	}
	id, err = identity.NewUUID()
	if err != nil {
		return "", "", time.Time{}, err
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO node_enrollments (id, employee_id, token_hash, created_at, expires_at)
		VALUES ($1::uuid, $2::uuid, $3, now(), now() + ($4::int * interval '1 second'))
		RETURNING expires_at`,
		id, employeeID, auth.Digest(token), seconds).Scan(&expires)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("保存注册凭据失败: %s", redact.Scrub(err.Error()))
	}
	return id, token, expires.UTC(), nil
}

// Register 消费一次性注册凭据，写入节点和可吊销的 credential_id，并在尚无默认 PC 时按注册序号选择最早的有效 PC。
// 连接凭据是签名后的 JWT，只在返回值里出现一次，不写入数据库。
func (s *Store) Register(ctx context.Context, in RegisterInput, signer node.TokenSigner) (node.Identity, error) {
	if err := node.Validate(in.DisplayName, in.System, in.Role, normalizeCaps(in.Capabilities)); err != nil {
		return node.Identity{}, err
	}
	if !node.ValidSecret(in.Token) {
		return node.Identity{}, ErrEnrollmentInvalid
	}
	if signer == nil {
		return node.Identity{}, errors.New("节点凭据签名器未配置")
	}
	seconds, err := positiveSeconds(in.CredentialTTL, maxCredentialSeconds)
	if err != nil {
		return node.Identity{}, errors.New("节点凭据有效期无效")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return node.Identity{}, fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var employeeID string
	err = tx.QueryRow(ctx, `
		UPDATE node_enrollments
		SET used_at = now()
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		RETURNING employee_id::text`, auth.Digest(in.Token)).Scan(&employeeID)
	if errors.Is(err, pgx.ErrNoRows) {
		return node.Identity{}, explainEnrollment(ctx, tx, in.Token)
	}
	if err != nil {
		return node.Identity{}, fmt.Errorf("核销注册凭据失败: %s", redact.Scrub(err.Error()))
	}

	// 锁住该员工的设置行，使注册序号和初始默认 PC 按同一顺序确定。
	if _, err := tx.Exec(ctx, `
		INSERT INTO employee_settings (employee_id, default_pc_node_id, updated_at)
		VALUES ($1::uuid, NULL, now())
		ON CONFLICT (employee_id) DO NOTHING`, employeeID); err != nil {
		return node.Identity{}, fmt.Errorf("保存节点设置失败: %s", redact.Scrub(err.Error()))
	}
	var currentDefault string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(default_pc_node_id::text, '')
		FROM employee_settings
		WHERE employee_id = $1::uuid
		FOR UPDATE`, employeeID).Scan(&currentDefault); err != nil {
		return node.Identity{}, fmt.Errorf("读取默认 PC 失败: %s", redact.Scrub(err.Error()))
	}

	nodeID, err := identity.NewUUID()
	if err != nil {
		return node.Identity{}, err
	}
	credentialID, err := identity.NewUUID()
	if err != nil {
		return node.Identity{}, err
	}
	expiresAt := time.Now().UTC().Add(time.Duration(seconds) * time.Second).Truncate(time.Second)
	connectionToken, err := signer.SignNodeToken(nodeID, employeeID, credentialID, expiresAt)
	if err != nil {
		return node.Identity{}, err
	}
	caps := normalizeCaps(in.Capabilities)
	var seq int64
	var registered time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO nodes (
			id, employee_id, display_name, system_name, role, capabilities,
			registration_seq, registered_at, credential_version
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, $6,
			nextval('node_registration_seq'), now(), 1
		)
		RETURNING registration_seq, registered_at`,
		nodeID, employeeID, in.DisplayName, in.System, in.Role, caps,
	).Scan(&seq, &registered)
	if err != nil {
		return node.Identity{}, fmt.Errorf("保存节点失败: %s", redact.Scrub(err.Error()))
	}
	var credentialExpires time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO node_credentials (
			id, node_id, employee_id, version, created_at, expires_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, 1, now(), $4
		)
		RETURNING expires_at`,
		credentialID, nodeID, employeeID, expiresAt,
	).Scan(&credentialExpires)
	if err != nil {
		return node.Identity{}, fmt.Errorf("保存节点凭据失败: %s", redact.Scrub(err.Error()))
	}

	if in.Role == node.RolePC && currentDefault == "" {
		var picked string
		err = tx.QueryRow(ctx, `
			UPDATE employee_settings AS es
			SET default_pc_node_id = picked.id, updated_at = now()
			FROM (
				SELECT id
				FROM nodes
				WHERE employee_id = $1::uuid AND role = 'pc' AND revoked_at IS NULL
				ORDER BY registration_seq ASC
				LIMIT 1
			) AS picked
			WHERE es.employee_id = $1::uuid AND es.default_pc_node_id IS NULL
			RETURNING picked.id::text`, employeeID).Scan(&picked)
		if err != nil {
			return node.Identity{}, fmt.Errorf("保存默认 PC 失败: %s", redact.Scrub(err.Error()))
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return node.Identity{}, fmt.Errorf("提交节点注册失败: %s", redact.Scrub(err.Error()))
	}
	return node.Identity{
		NodeID:          nodeID,
		EmployeeID:      employeeID,
		DisplayName:     in.DisplayName,
		System:          in.System,
		Role:            in.Role,
		Capabilities:    caps,
		RegistrationSeq: seq,
		RegisteredAt:    registered.UTC(),
		Credential: node.Credential{
			ID:        credentialID,
			Version:   1,
			Token:     connectionToken,
			ExpiresAt: credentialExpires.UTC(),
		},
	}, nil
}

// SetDefaultPC 把默认 PC 改成该员工自己的另一个有效 PC，并返回数据库中的实际结果。
func (s *Store) SetDefaultPC(ctx context.Context, employeeID, nodeID string) (node.SavedDefault, error) {
	var err error
	employeeID, err = identity.ParseUUID(employeeID)
	if err != nil {
		return node.SavedDefault{}, ErrDefaultRejected
	}
	nodeID, err = identity.ParseUUID(nodeID)
	if err != nil {
		return node.SavedDefault{}, ErrDefaultRejected
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return node.SavedDefault{}, fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		INSERT INTO employee_settings (employee_id, default_pc_node_id, updated_at)
		VALUES ($1::uuid, NULL, now())
		ON CONFLICT (employee_id) DO NOTHING`, employeeID); err != nil {
		return node.SavedDefault{}, fmt.Errorf("保存节点设置失败: %s", redact.Scrub(err.Error()))
	}
	var locked string
	if err := tx.QueryRow(ctx, `
		SELECT employee_id::text
		FROM employee_settings
		WHERE employee_id = $1::uuid
		FOR UPDATE`, employeeID).Scan(&locked); err != nil {
		return node.SavedDefault{}, fmt.Errorf("读取默认 PC 失败: %s", redact.Scrub(err.Error()))
	}

	var role string
	var inactive bool
	err = tx.QueryRow(ctx, `
		SELECT role, revoked_at IS NOT NULL
		FROM nodes
		WHERE id = $1::uuid AND employee_id = $2::uuid
		FOR UPDATE`, nodeID, employeeID).Scan(&role, &inactive)
	if errors.Is(err, pgx.ErrNoRows) {
		return node.SavedDefault{}, ErrDefaultRejected
	}
	if err != nil {
		return node.SavedDefault{}, fmt.Errorf("读取节点失败: %s", redact.Scrub(err.Error()))
	}
	if inactive {
		return node.SavedDefault{}, ErrNodeInactive
	}
	if role != node.RolePC {
		return node.SavedDefault{}, ErrNotPCNode
	}
	tag, err := tx.Exec(ctx, `
		UPDATE employee_settings
		SET default_pc_node_id = $2::uuid, updated_at = now()
		WHERE employee_id = $1::uuid`, employeeID, nodeID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return node.SavedDefault{}, ErrDefaultRejected
		}
		return node.SavedDefault{}, fmt.Errorf("保存默认 PC 失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() != 1 {
		return node.SavedDefault{}, fmt.Errorf("保存默认 PC 失败")
	}
	var saved node.SavedDefault
	err = tx.QueryRow(ctx, `
		SELECT n.id::text, n.display_name, n.system_name, n.role, n.registration_seq
		FROM employee_settings es
		JOIN nodes n ON n.id = es.default_pc_node_id AND n.employee_id = es.employee_id
		WHERE es.employee_id = $1::uuid`, employeeID).Scan(
		&saved.NodeID, &saved.DisplayName, &saved.System, &saved.Role, &saved.RegistrationSeq)
	if err != nil {
		return node.SavedDefault{}, fmt.Errorf("读取默认 PC 失败: %s", redact.Scrub(err.Error()))
	}
	if saved.NodeID != nodeID {
		return node.SavedDefault{}, fmt.Errorf("读取默认 PC 失败")
	}
	if err := tx.Commit(ctx); err != nil {
		return node.SavedDefault{}, fmt.Errorf("提交默认 PC 失败: %s", redact.Scrub(err.Error()))
	}
	return saved, nil
}

func explainEnrollment(ctx context.Context, tx pgx.Tx, token string) error {
	var used, expired bool
	err := tx.QueryRow(ctx, `
		SELECT used_at IS NOT NULL, expires_at <= now()
		FROM node_enrollments
		WHERE token_hash = $1`, auth.Digest(token)).Scan(&used, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrEnrollmentInvalid
	}
	if err != nil {
		return fmt.Errorf("查询注册凭据失败: %s", redact.Scrub(err.Error()))
	}
	if used {
		return ErrEnrollmentUsed
	}
	if expired {
		return ErrEnrollmentExpired
	}
	return ErrEnrollmentInvalid
}

func positiveSeconds(ttl time.Duration, max int) (int, error) {
	if ttl < time.Second {
		return 0, errors.New("ttl")
	}
	seconds := int(ttl.Seconds())
	if seconds < 1 || seconds > max {
		return 0, errors.New("ttl")
	}
	return seconds, nil
}

func normalizeCaps(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

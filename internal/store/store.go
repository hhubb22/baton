// Package store 把员工、登录会话、节点和任务接受记录写入 PostgreSQL。口令与凭据明文不进入数据库。
package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"baton/internal/auth"
	"baton/internal/identity"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound           = errors.New("not found")
	ErrUsernameTaken      = errors.New("username taken")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrCredentialChanged  = errors.New("credential changed")
)

// Credential 是本地账号校验所需的身份和口令摘要。摘要不得写入日志或 API。
type Credential struct {
	Employee     identity.Employee
	PasswordHash string
}

// Session 是一次已通过校验的服务端登录。
type Session struct {
	ID        string
	ExpiresAt time.Time
	Employee  identity.Employee
	CSRFHash  []byte
}

type Store struct {
	pool               *pgxpool.Pool
	mu                 sync.Mutex
	beforeCommit       func(context.Context) error
	beforeStartCommit  func(context.Context) error
	beforeCancelCommit func(context.Context) error
}

var _ identity.Directory = (*Store)(nil)

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) InsertLocalEmployee(ctx context.Context, employee identity.Employee, passwordHash string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO employees (
			id, username, display_name, auth_source, external_subject,
			password_hash, must_change_password, password_changed_at, created_at, updated_at
		) VALUES (
			$1::uuid, $2, $3, 'local', NULL,
			$4, true, NULL, now(), now()
		)`, employee.ID, employee.Username, employee.DisplayName, passwordHash)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ErrUsernameTaken
		}
		return fmt.Errorf("创建员工失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

func (s *Store) FindLocalCredential(ctx context.Context, username string) (Credential, error) {
	var cred Credential
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, username, display_name, auth_source, password_hash, must_change_password
		FROM employees
		WHERE username = $1 AND auth_source = 'local'`, username).Scan(
		&cred.Employee.ID,
		&cred.Employee.Username,
		&cred.Employee.DisplayName,
		&cred.Employee.AuthSource,
		&cred.PasswordHash,
		&cred.Employee.MustChangePassword,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Credential{}, ErrNotFound
	}
	if err != nil {
		return Credential{}, fmt.Errorf("查询员工失败: %s", redact.Scrub(err.Error()))
	}
	return cred, nil
}

// FindExternal 实现 identity.Directory。它只返回映射，不创建会话。
func (s *Store) FindExternal(ctx context.Context, source, subject string) (identity.Employee, error) {
	if source == "" || source == identity.SourceLocal || subject == "" {
		return identity.Employee{}, ErrNotFound
	}
	var emp identity.Employee
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, username, display_name, auth_source, external_subject, must_change_password
		FROM employees
		WHERE auth_source = $1 AND external_subject = $2`, source, subject).Scan(
		&emp.ID,
		&emp.Username,
		&emp.DisplayName,
		&emp.AuthSource,
		&emp.ExternalSubject,
		&emp.MustChangePassword,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return identity.Employee{}, ErrNotFound
	}
	if err != nil {
		return identity.Employee{}, fmt.Errorf("查询外部身份失败: %s", redact.Scrub(err.Error()))
	}
	return emp, nil
}

// InsertSession 在口令摘要仍与校验时一致的情况下写入会话。
// 员工行锁使会话创建与口令替换串行，替换提交后不能再用旧摘要创建会话。
// 数据库保存令牌摘要。返回的 token 与 csrf 只交给调用方设置 Cookie 和响应。
func (s *Store) InsertSession(ctx context.Context, employeeID, verifiedHash string, ttl time.Duration) (token, csrf string, expires time.Time, err error) {
	token, err = auth.NewSecret()
	if err != nil {
		return "", "", time.Time{}, err
	}
	csrf, err = auth.NewSecret()
	if err != nil {
		return "", "", time.Time{}, err
	}
	sessionID, err := identity.NewUUID()
	if err != nil {
		return "", "", time.Time{}, err
	}
	seconds := int(ttl.Seconds())
	if seconds < 1 {
		return "", "", time.Time{}, errors.New("会话有效期无效")
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO login_sessions (id, employee_id, token_hash, csrf_hash, created_at, expires_at)
		SELECT $1::uuid, $2::uuid, $3, $4, now(), now() + ($5::int * interval '1 second')
		WHERE EXISTS (
			SELECT 1 FROM employees
			WHERE id = $2::uuid AND auth_source = 'local' AND password_hash = $6
			FOR UPDATE
		)
		RETURNING expires_at`,
		sessionID, employeeID, auth.Digest(token), auth.Digest(csrf), seconds, verifiedHash,
	).Scan(&expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", time.Time{}, ErrCredentialChanged
	}
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("保存会话失败: %s", redact.Scrub(err.Error()))
	}
	return token, csrf, expires, nil
}

func (s *Store) LookupSession(ctx context.Context, token string) (Session, error) {
	var sess Session
	var revoked bool
	var expired bool
	err := s.pool.QueryRow(ctx, `
		SELECT s.id::text, s.csrf_hash, s.expires_at,
		       s.revoked_at IS NOT NULL,
		       s.expires_at <= now(),
		       e.id::text, e.username, e.display_name, e.auth_source, e.must_change_password
		FROM login_sessions s
		JOIN employees e ON e.id = s.employee_id
		WHERE s.token_hash = $1`, auth.Digest(token)).Scan(
		&sess.ID,
		&sess.CSRFHash,
		&sess.ExpiresAt,
		&revoked,
		&expired,
		&sess.Employee.ID,
		&sess.Employee.Username,
		&sess.Employee.DisplayName,
		&sess.Employee.AuthSource,
		&sess.Employee.MustChangePassword,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("查询会话失败: %s", redact.Scrub(err.Error()))
	}
	if revoked {
		return Session{}, ErrNotFound
	}
	if expired {
		return Session{}, ErrSessionExpired
	}
	return sess, nil
}

// ErrSessionExpired 表示令牌曾签发但已经超过 expires_at。
var ErrSessionExpired = errors.New("session expired")

func (s *Store) RevokeSession(ctx context.Context, sessionID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE login_sessions
		SET revoked_at = now()
		WHERE id = $1::uuid AND revoked_at IS NULL AND expires_at > now()`, sessionID)
	if err != nil {
		return fmt.Errorf("注销会话失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetLocalPassword 在旧摘要仍匹配时更换口令，并注销该员工的全部会话。
func (s *Store) SetLocalPassword(ctx context.Context, employeeID, oldHash, newHash string, mustChange bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tag pgconn.CommandTag
	if mustChange {
		tag, err = tx.Exec(ctx, `
			UPDATE employees
			SET password_hash = $2, must_change_password = true, password_changed_at = NULL, updated_at = now()
			WHERE id = $1::uuid AND auth_source = 'local' AND password_hash = $3`,
			employeeID, newHash, oldHash)
	} else {
		tag, err = tx.Exec(ctx, `
			UPDATE employees
			SET password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now()
			WHERE id = $1::uuid AND auth_source = 'local' AND password_hash = $3`,
			employeeID, newHash, oldHash)
	}
	if err != nil {
		return fmt.Errorf("更新口令失败: %s", redact.Scrub(err.Error()))
	}
	if tag.RowsAffected() == 0 {
		return ErrCredentialChanged
	}
	if _, err := tx.Exec(ctx, `
		UPDATE login_sessions
		SET revoked_at = now()
		WHERE employee_id = $1::uuid AND revoked_at IS NULL`, employeeID); err != nil {
		return fmt.Errorf("注销旧会话失败: %s", redact.Scrub(err.Error()))
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("提交口令更换失败: %s", redact.Scrub(err.Error()))
	}
	return nil
}

// ResetLocalPassword 由管理员设置新的一次性口令，不要求提供旧摘要，并注销全部会话。
func (s *Store) ResetLocalPassword(ctx context.Context, username, newHash string) (identity.Employee, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return identity.Employee{}, fmt.Errorf("开始事务失败: %s", redact.Scrub(err.Error()))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var emp identity.Employee
	err = tx.QueryRow(ctx, `
		UPDATE employees
		SET password_hash = $2, must_change_password = true, password_changed_at = NULL, updated_at = now()
		WHERE username = $1 AND auth_source = 'local'
		RETURNING id::text, username, display_name, auth_source, must_change_password`,
		username, newHash).Scan(&emp.ID, &emp.Username, &emp.DisplayName, &emp.AuthSource, &emp.MustChangePassword)
	if errors.Is(err, pgx.ErrNoRows) {
		return identity.Employee{}, ErrNotFound
	}
	if err != nil {
		return identity.Employee{}, fmt.Errorf("重置口令失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := tx.Exec(ctx, `
		UPDATE login_sessions
		SET revoked_at = now()
		WHERE employee_id = $1::uuid AND revoked_at IS NULL`, emp.ID); err != nil {
		return identity.Employee{}, fmt.Errorf("注销旧会话失败: %s", redact.Scrub(err.Error()))
	}
	if err := tx.Commit(ctx); err != nil {
		return identity.Employee{}, fmt.Errorf("提交口令重置失败: %s", redact.Scrub(err.Error()))
	}
	return emp, nil
}

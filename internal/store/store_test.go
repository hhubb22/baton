package store_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"baton/internal/admin"
	"baton/internal/auth"
	"baton/internal/dbtest"
	"baton/internal/identity"
	"baton/internal/migrate"
	"baton/internal/redact"
	"baton/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateIsIdempotentAndPlaintextIsRejected(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := migrate.Up(ctx, pool); err != nil {
		t.Fatalf("重复迁移失败: %s", redact.Scrub(err.Error()))
	}
	if err := migrate.Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	const plaintext = "plaintext-password-value"
	_, err = pool.Exec(ctx, `
		INSERT INTO employees (
			id, username, display_name, auth_source, external_subject,
			password_hash, must_change_password, created_at, updated_at
		) VALUES (
			$1::uuid, 'plainuser', 'Plain', 'local', NULL,
			$2, true, now(), now()
		)`, id, plaintext)
	if err == nil {
		t.Fatal("明文口令被写入")
	}
	if strings.Contains(err.Error(), plaintext) {
		t.Fatal("数据库错误回显了明文口令")
	}
}

func TestExternalDirectoryDoesNotCreateSession(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id, err := identity.NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO employees (
			id, username, display_name, auth_source, external_subject,
			password_hash, must_change_password, created_at, updated_at
		) VALUES (
			$1::uuid, 'extuser', 'External Person', 'directory', 'person-1',
			NULL, false, now(), now()
		)`, id)
	if err != nil {
		t.Fatalf("写入外部映射失败: %s", redact.Scrub(err.Error()))
	}
	repo := store.New(pool)
	emp, err := repo.FindExternal(ctx, "directory", "person-1")
	if err != nil || emp.ID != id || emp.Username != "extuser" || emp.AuthSource != "directory" {
		t.Fatalf("外部映射查询失败: %v", err)
	}
	if _, err := repo.FindExternal(ctx, identity.SourceLocal, "person-1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("本地来源被当作外部映射")
	}
	if _, err := repo.FindLocalCredential(ctx, "extuser"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("外部账号可以走本地口令查询")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM login_sessions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("外部映射查询创建了会话")
	}
}

func TestSessionInsertRequiresCurrentPasswordHash(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const password = "correct-horse-battery-9"
	emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice Person", password)
	if err != nil {
		t.Fatal(err)
	}
	cred, err := store.New(pool).FindLocalCredential(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := auth.HashPassword("another-secret-009")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE employees SET password_hash = $2 WHERE id = $1::uuid`, emp.ID, replacement); err != nil {
		t.Fatalf("更新摘要失败: %s", redact.Scrub(err.Error()))
	}
	_, _, _, err = store.New(pool).InsertSession(ctx, emp.ID, cred.PasswordHash, time.Hour)
	if !errors.Is(err, store.ErrCredentialChanged) {
		t.Fatal("口令变更后仍用旧摘要创建了会话")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM login_sessions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("旧摘要写入了会话")
	}
	if _, err := admin.CreateLocal(ctx, pool, "alice", "Alice Person", password); err == nil {
		t.Fatal("重复用户名被接受")
	}
}

func TestSessionInsertDuringPasswordReplacement(t *testing.T) {
	pool := dbtest.Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	repo := store.New(pool)
	emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "initial-password-001")
	if err != nil {
		t.Fatal(err)
	}
	cred, err := repo.FindLocalCredential(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	nextHash, err := auth.HashPassword("replacement-password-002")
	if err != nil {
		t.Fatal(err)
	}

	// 保持口令替换及旧会话注销尚未提交，模拟与登录重叠的重置事务。
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var resetPID int
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&resetPID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE employees SET password_hash = $2 WHERE id = $1::uuid`, emp.ID, nextHash); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE login_sessions SET revoked_at = now() WHERE employee_id = $1::uuid AND revoked_at IS NULL`, emp.ID); err != nil {
		t.Fatal(err)
	}
	type result struct {
		token string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		token, _, _, err := repo.InsertSession(ctx, emp.ID, cred.PasswordHash, time.Hour)
		done <- result{token: token, err: err}
	}()

	// 等到登录完成或数据库确认它在等待重置事务，避免靠固定延时安排顺序。
	var got result
	completed := false
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
wait:
	for {
		select {
		case got = <-done:
			completed = true
			break wait
		case <-ticker.C:
			var blocked bool
			if err := pool.QueryRow(ctx, `SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
			)`, resetPID).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				break wait
			}
		case <-ctx.Done():
			t.Fatal("未观察到登录完成或等待重置事务")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if !completed {
		select {
		case got = <-done:
		case <-ctx.Done():
			t.Fatal("重置提交后登录未结束")
		}
	}
	if got.err == nil {
		if _, err := repo.LookupSession(ctx, got.token); err == nil {
			t.Fatal("口令替换提交后，与它重叠的旧口令登录留下了有效会话")
		}
	}
	if !errors.Is(got.err, store.ErrCredentialChanged) {
		t.Fatalf("重叠的旧口令登录应被拒绝，错误为 %v", got.err)
	}
	var active int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM login_sessions WHERE employee_id = $1::uuid AND revoked_at IS NULL`, emp.ID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatalf("口令替换后剩余 %d 个有效会话", active)
	}
}

func TestPasswordReplacementWaitsForSessionInsert(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(fmt.Sprintf("admin_reset=%t", reset), func(t *testing.T) {
			pool := dbtest.Open(t)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			repo := store.New(pool)
			emp, err := admin.CreateLocal(ctx, pool, "alice", "Alice", "initial-password-001")
			if err != nil {
				t.Fatal(err)
			}
			cred, err := repo.FindLocalCredential(ctx, "alice")
			if err != nil {
				t.Fatal(err)
			}
			nextHash, err := auth.HashPassword("replacement-password-002")
			if err != nil {
				t.Fatal(err)
			}

			gate, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = gate.Rollback(ctx) }()
			var gatePID int
			if err := gate.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
				t.Fatal(err)
			}
			if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock(71001, $1)`, gatePID); err != nil {
				t.Fatal(err)
			}
			// 测试触发器让登录停在插入会话前，员工锁仍由真实 InsertSession 持有。
			if _, err := pool.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION pause_session_insert() RETURNS trigger
				LANGUAGE plpgsql AS $$ BEGIN
				PERFORM pg_advisory_xact_lock(71001, %d);
				RETURN NEW;
				END $$`, gatePID)); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `CREATE TRIGGER pause_session_insert BEFORE INSERT ON login_sessions
				FOR EACH ROW EXECUTE FUNCTION pause_session_insert()`); err != nil {
				t.Fatal(err)
			}
			type loginResult struct {
				token string
				err   error
			}
			loginDone := make(chan loginResult, 1)
			go func() {
				token, _, _, err := repo.InsertSession(ctx, emp.ID, cred.PasswordHash, time.Hour)
				loginDone <- loginResult{token: token, err: err}
			}()
			loginPID := waitForBlockedBy(t, ctx, pool, gatePID)
			replaceDone := make(chan error, 1)
			go func() {
				if reset {
					_, err := repo.ResetLocalPassword(ctx, "alice", nextHash)
					replaceDone <- err
				} else {
					replaceDone <- repo.SetLocalPassword(ctx, emp.ID, cred.PasswordHash, nextHash, false)
				}
			}()
			waitForBlockedBy(t, ctx, pool, loginPID)
			if err := gate.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var login loginResult
			select {
			case login = <-loginDone:
				if login.err != nil {
					t.Fatal(login.err)
				}
			case <-ctx.Done():
				t.Fatal("登录未结束")
			}
			select {
			case err := <-replaceDone:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("口令替换未结束")
			}
			if _, err := repo.LookupSession(ctx, login.token); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("口令替换必须注销先提交的登录会话，错误为 %v", err)
			}
		})
	}
}

func waitForBlockedBy(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blockerPID int) int {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int
		err := pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity
			WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1), 0)`, blockerPID).Scan(&pid)
		if err != nil {
			t.Fatal(err)
		}
		if pid != 0 {
			return pid
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("未观察到预期的数据库锁等待")
		}
	}
}

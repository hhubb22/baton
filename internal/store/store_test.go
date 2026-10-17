package store_test

import (
	"context"
	"errors"
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

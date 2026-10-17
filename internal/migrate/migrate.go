// Package migrate 按文件名顺序应用嵌入的 SQL。
// 每个迁移文件在一个事务中整段交给 PostgreSQL，不在客户端拆分语句。
package migrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"baton/internal/db"
	"baton/internal/redact"
	"baton/migrations"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const lockKey int64 = 4815162342

var errNoStatement = errors.New("没有可执行语句")

// Versions 返回嵌入的迁移文件名。
func Versions() ([]string, error) {
	return readVersions(migrations.Files)
}

func readVersions(files fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return nil, err
	}
	var versions []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		if !fileNameOK(name) {
			return nil, fmt.Errorf("迁移文件名无效")
		}
		versions = append(versions, name)
	}
	sort.Strings(versions)
	if len(versions) == 0 {
		return nil, errors.New("没有可执行的迁移")
	}
	return versions, nil
}

func fileNameOK(name string) bool {
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '.':
		default:
			return false
		}
	}
	return true
}

// Up 在当前 search_path 中执行尚未记录的迁移。重复执行不会改写已完成的版本。
func Up(ctx context.Context, pool *pgxpool.Pool) error {
	return upFS(ctx, pool, migrations.Files)
}

func upFS(ctx context.Context, pool *pgxpool.Pool, files fs.FS) error {
	want, err := readVersions(files)
	if err != nil {
		return err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("获取数据库连接失败: %s", redact.Scrub(err.Error()))
	}
	defer conn.Release()

	var current string
	if err := conn.QueryRow(ctx, "SELECT current_schema()").Scan(&current); err != nil {
		return fmt.Errorf("读取 schema 失败: %s", redact.Scrub(err.Error()))
	}
	if _, err := db.QuoteIdent(current); err != nil || current == "" {
		return errors.New("当前 schema 无效，拒绝迁移")
	}

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return fmt.Errorf("获取迁移锁失败: %s", redact.Scrub(err.Error()))
	}
	defer func() {
		_, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", lockKey)
	}()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version text PRIMARY KEY,
			applied_at timestamptz NOT NULL
		)`); err != nil {
		return fmt.Errorf("创建迁移记录表失败: %s", redact.Scrub(err.Error()))
	}

	for _, version := range want {
		var exists bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, version).Scan(&exists); err != nil {
			return fmt.Errorf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
		}
		if exists {
			continue
		}
		body, err := fs.ReadFile(files, version)
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(body)) == "" {
			return fmt.Errorf("迁移 %s 没有可执行语句", version)
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("开始迁移事务失败: %s", redact.Scrub(err.Error()))
		}
		if err := execScript(ctx, tx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			if errors.Is(err, errNoStatement) {
				return fmt.Errorf("迁移 %s 没有可执行语句", version)
			}
			return fmt.Errorf("执行迁移 %s 失败: %s", version, redact.Scrub(err.Error()))
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, now())`, version); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("记录迁移 %s 失败: %s", version, redact.Scrub(err.Error()))
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("提交迁移 %s 失败: %s", version, redact.Scrub(err.Error()))
		}
	}
	return nil
}

// execScript 用简单查询协议执行整段脚本，不绑定参数。
// 调用时事务必须已经开始。脚本不能自行提交或回滚这段事务。
func execScript(ctx context.Context, tx pgx.Tx, script string) error {
	mrr := tx.Conn().PgConn().Exec(ctx, script)
	saw := false
	for mrr.NextResult() {
		saw = true
		if _, err := mrr.ResultReader().Close(); err != nil {
			_ = mrr.Close()
			return err
		}
	}
	if err := mrr.Close(); err != nil {
		return err
	}
	if !saw {
		return errNoStatement
	}
	if tx.Conn().PgConn().TxStatus() != 'T' {
		return errors.New("迁移脚本不能结束当前事务")
	}
	return nil
}

// Check 确认当前 schema 已应用全部迁移。
func Check(ctx context.Context, pool *pgxpool.Pool) error {
	want, err := Versions()
	if err != nil {
		return err
	}
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
			return errors.New("数据库迁移未完成，请先执行 migrate")
		}
		return fmt.Errorf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return fmt.Errorf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
		}
		got = append(got, version)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
	}
	if len(got) != len(want) {
		return errors.New("数据库迁移未完成，请先执行 migrate")
	}
	for i := range want {
		if got[i] != want[i] {
			return errors.New("数据库迁移未完成，请先执行 migrate")
		}
	}
	return nil
}

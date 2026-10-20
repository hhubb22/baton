// Package db 打开 PostgreSQL，并把每个连接的 search_path 固定到指定 schema。
package db

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"baton/internal/redact"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var identPattern = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// QuoteIdent 只接受小写标识符，避免把连接参数拼进 SQL。
func QuoteIdent(name string) (string, error) {
	if !identPattern.MatchString(name) {
		return "", errors.New("schema 名称无效")
	}
	return `"` + name + `"`, nil
}

// Open 连接 databaseURL，创建 schema，并让池中的每条连接都使用它。
// 先创建 schema 再设置 search_path，避免建表落到 public。
func Open(ctx context.Context, databaseURL, schema string) (*pgxpool.Pool, error) {
	ident, err := QuoteIdent(schema)
	if err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("解析数据库配置失败，请检查 BATON_DATABASE_URL")
	}
	cfg.MaxConns = 8
	cfg.ConnConfig.ConnectTimeout = 10 * time.Second
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		var exists bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)`, schema).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if _, err := conn.Exec(ctx, "CREATE SCHEMA "+ident); err != nil {
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "42P06" {
					return err
				}
			}
		}
		if _, err := conn.Exec(ctx, "SET search_path TO "+ident); err != nil {
			return err
		}
		var current string
		if err := conn.QueryRow(ctx, "SELECT current_schema()").Scan(&current); err != nil {
			return err
		}
		if current != schema {
			return errors.New("search_path 未落到指定 schema")
		}
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("连接数据库失败: %s", redact.Scrub(err.Error()))
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("连接数据库失败: %s", redact.Scrub(err.Error()))
	}
	if err := requirePostgreSQL(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func requirePostgreSQL(ctx context.Context, pool *pgxpool.Pool) error {
	var versionNum int
	var version string
	if err := pool.QueryRow(ctx, "SELECT current_setting('server_version_num')::int, current_setting('server_version')").Scan(&versionNum, &version); err != nil {
		return fmt.Errorf("读取数据库版本失败: %s", redact.Scrub(err.Error()))
	}
	return validatePostgreSQLVersion(versionNum, version)
}

func validatePostgreSQLVersion(versionNum int, version string) error {
	if versionNum < 160000 {
		return fmt.Errorf("需要 PostgreSQL 16 或更高版本，当前为 %s", version)
	}
	return nil
}

package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"baton/internal/db"
	"baton/internal/migrate"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Open 使用 BATON_TEST_DATABASE_URL 建立独立 schema 并完成迁移。
// 未设置该变量或连接失败时测试失败，不改用模拟数据库。
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("BATON_TEST_DATABASE_URL"))
	if raw == "" {
		t.Fatal("BATON_TEST_DATABASE_URL 未设置，集成测试不能改用模拟数据库")
	}
	schema, err := randomSchema()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, raw, schema)
	if err != nil {
		t.Fatalf("打开测试数据库失败: %s", redact.Scrub(err.Error()))
	}
	if err := migrate.Up(ctx, pool); err != nil {
		pool.Close()
		t.Fatalf("迁移失败: %s", redact.Scrub(err.Error()))
	}
	var version, dbname, current string
	if err := pool.QueryRow(ctx, "SELECT current_setting('server_version'), current_database(), current_schema()").Scan(&version, &dbname, &current); err != nil {
		pool.Close()
		t.Fatalf("读取数据库信息失败: %s", redact.Scrub(err.Error()))
	}
	if current != schema {
		pool.Close()
		t.Fatalf("当前 schema 为 %s", current)
	}
	t.Logf("postgres %s database %s schema %s", version, dbname, current)
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer ccancel()
		var n int
		if err := pool.QueryRow(cctx, `
			SELECT COUNT(*) FROM information_schema.tables
			WHERE table_schema = 'public'
			  AND table_name IN (
			    'employees', 'login_sessions', 'schema_migrations',
			    'node_enrollments', 'nodes', 'node_credentials', 'employee_settings',
			    'node_presence'
			  )`).Scan(&n); err != nil {
			t.Errorf("检查 public 失败: %s", redact.Scrub(err.Error()))
		} else if n != 0 {
			t.Errorf("迁移写入了 public，共 %d 张表", n)
		}
		ident, err := db.QuoteIdent(schema)
		if err != nil {
			t.Errorf("schema 名称无效")
			pool.Close()
			return
		}
		if _, err := pool.Exec(cctx, "DROP SCHEMA IF EXISTS "+ident+" CASCADE"); err != nil {
			t.Errorf("清理测试 schema 失败: %s", redact.Scrub(err.Error()))
		}
		pool.Close()
	})
	return pool
}

func randomSchema() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "t" + hex.EncodeToString(raw[:]), nil
}

package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"baton/internal/db"
	"baton/internal/migrate"
	"baton/internal/redact"

	"github.com/jackc/pgx/v5/pgxpool"
)

const DefaultURL = "postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable"

var ensureLocalOnce sync.Once

// URL 返回测试数据库连接串；未设置 BATON_TEST_DATABASE_URL 时默认使用本地 PostgreSQL。
func URL() string {
	if raw := strings.TrimSpace(os.Getenv("BATON_TEST_DATABASE_URL")); raw != "" {
		return raw
	}
	ensureLocalPostgres()
	return DefaultURL
}

func ensureLocalPostgres() {
	ensureLocalOnce.Do(func() {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:5432", 300*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		pgdata := filepath.Join(home, ".baton-postgres")
		if _, err := os.Stat(pgdata); err != nil {
			return
		}
		for _, bin := range []string{"pg_ctl", "/opt/homebrew/opt/postgresql@17/bin/pg_ctl", "/usr/local/opt/postgresql@17/bin/pg_ctl"} {
			if path, err := exec.LookPath(bin); err == nil {
				_ = exec.Command(path, "-D", pgdata, "-l", filepath.Join(pgdata, "postgres.log"), "start").Run()
				return
			}
		}
	})
}

// Open 建立独立 schema 并完成迁移。
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := URL()
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
			    'node_presence', 'node_revocations', 'node_runtime_reports',
			    'threads', 'thread_messages', 'thread_turns', 'thread_replies',
			    'thread_events', 'thread_outbox', 'thread_reports',
			    'projects', 'project_agents', 'conversations', 'conversation_events',
			    'project_agent_input_queue', 'agent_runs', 'project_memory_entries',
			    'project_memory_revisions', 'attention_requests'
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

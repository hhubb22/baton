package migrate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"baton/internal/db"
	"baton/internal/redact"
	"baton/migrations"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultTestDatabaseURL = "postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable"

func TestScriptKeepsFunctionTriggerDoAndComments(t *testing.T) {
	pool := openTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	files := os.DirFS("testdata/script")
	if err := upFS(ctx, pool, files); err != nil {
		t.Fatalf("合成迁移失败: %s", redact.Scrub(err.Error()))
	}
	if err := upFS(ctx, pool, files); err != nil {
		t.Fatalf("重复执行合成迁移失败: %s", redact.Scrub(err.Error()))
	}

	var note, label string
	if err := pool.QueryRow(ctx, `SELECT widget_note(), label FROM widget WHERE id = 1`).Scan(&note, &label); err != nil {
		t.Fatalf("读取函数和触发行失败: %s", redact.Scrub(err.Error()))
	}
	if note != "keep; this" {
		t.Fatalf("函数体被拆开: %s", note)
	}
	if label != "a;b'c;trg" {
		t.Fatalf("E'' 字符串或触发器未完整执行: %s", label)
	}
	if tableExists(t, ctx, pool, "should_not_exist") {
		t.Fatal("块注释中的语句被执行")
	}
	assertInSchema(t, ctx, pool, "widget")
	assertFunctionSchema(t, ctx, pool, "widget_note")
	assertFunctionSchema(t, ctx, pool, "widget_label")
	assertTriggerSchema(t, ctx, pool, "widget_label_trg")
	got := migrationVersions(t, ctx, pool)
	want := []string{"0001_widget.sql", "0002_widget_behavior.sql"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("迁移记录 = %v", got)
	}
}

func TestFailedMigrationRollsBackFile(t *testing.T) {
	pool := openTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := upFS(ctx, pool, os.DirFS("testdata/rollback"))
	if err == nil || !strings.Contains(err.Error(), "0002_fail.sql") {
		t.Fatalf("失败迁移应返回文件错误: %s", redact.Scrub(errorText(err)))
	}
	if !tableExists(t, ctx, pool, "kept") {
		t.Fatal("已提交的迁移被回滚")
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM kept`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("已提交迁移的数据 = %d, %v", n, err)
	}
	if tableExists(t, ctx, pool, "doomed") {
		t.Fatal("失败迁移的表没有回滚")
	}
	got := migrationVersions(t, ctx, pool)
	if strings.Join(got, ",") != "0001_keep.sql" {
		t.Fatalf("失败版本被记录: %v", got)
	}
}

func TestConcurrentMigrationRunsOnce(t *testing.T) {
	pool := openTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	files := os.DirFS("testdata/concurrent")
	start := make(chan struct{})
	errs := make([]error, 2)
	var wg sync.WaitGroup
	wg.Add(len(errs))
	for i := range errs {
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = upFS(ctx, pool, files)
		}(i)
	}
	close(start)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("并发迁移 %d 失败: %s", i, redact.Scrub(err.Error()))
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM once_run`).Scan(&n); err != nil {
		t.Fatalf("读取并发迁移结果失败: %s", redact.Scrub(err.Error()))
	}
	if n != 1 {
		t.Fatalf("迁移被执行了 %d 次", n)
	}
	got := migrationVersions(t, ctx, pool)
	if strings.Join(got, ",") != "0001_once.sql" {
		t.Fatalf("并发迁移记录 = %v", got)
	}
	assertInSchema(t, ctx, pool, "once_run")
}

func TestBaselineCreatesCurrentSchemaAndStaysStable(t *testing.T) {
	pool := openTestDB(t)
	ctx := t.Context()
	if err := Check(ctx, pool); err == nil {
		t.Fatal("空 schema 被视为迁移完成")
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
	for _, table := range currentTables {
		assertInSchema(t, ctx, pool, table)
	}
	for _, table := range retiredTables {
		if tableExists(t, ctx, pool, table) {
			t.Fatal("创建了已移除的表", table)
		}
	}
	var columns int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema()
		AND ((table_name='attention_requests' AND column_name IN ('task_id','task_result_version','task_result'))
		OR (table_name='nodes' AND column_name='role')
		OR (table_name='employee_settings' AND column_name='default_pc_node_id')
		OR (table_name='node_credentials' AND column_name='token_hash')
		OR (table_name='thread_reports' AND column_name='payload_hash_version'))`).Scan(&columns); err != nil || columns != 0 {
		t.Fatal("存在已移除的列", columns, err)
	}
	want, err := Versions()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(want, ",") != "0001_initial.sql,0002_ts_threads.sql,0003_thread_tracing.sql,0004_inbox_options.sql,0005_thread_settings.sql,0006_thread_answers.sql" {
		t.Fatalf("嵌入迁移 = %v", want)
	}
	if got := migrationVersions(t, ctx, pool); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("迁移记录 = %v", got)
	}
	before := schemaFingerprint(t, ctx, pool)
	for _, fragment := range []string{"employees:password_hash:", "node_presence:incarnation:", "node_registration_seq",
		"threads:request_hash:", "threads:model:", "threads:exec_wait_until:", "thread_messages:model:",
		"thread_messages:status_reason:", "thread_turns:model:", "project_agents:model:",
		"thread_outbox:completed_at:", "thread_outbox:completion:", "thread_outbox:trace_context:"} {
		if !strings.Contains(before, fragment) {
			t.Fatal("缺少当前字段或序列", fragment)
		}
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if after := schemaFingerprint(t, ctx, pool); after != before {
		t.Fatalf("重复迁移改变了 schema 或迁移记录\n之前:\n%s\n之后:\n%s", before, after)
	}
}

func TestBaselineFailureRollsBackAndCanRetry(t *testing.T) {
	pool := openTestDB(t)
	ctx := t.Context()
	body, err := fs.ReadFile(migrations.Files, "0001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{"0001_initial.sql": &fstest.MapFile{Data: append(body, []byte("\nSELECT 1/0;\n")...)}}
	if err := upFS(ctx, pool, files); err == nil || !strings.Contains(err.Error(), "0001_initial.sql") {
		t.Fatal("基线错误未返回", err)
	}
	for _, table := range currentTables {
		if table != "schema_migrations" && tableExists(t, ctx, pool, table) {
			t.Fatal("失败基线留下表", table)
		}
	}
	var objects int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM pg_sequences WHERE schemaname=current_schema()) +
		(SELECT count(*) FROM pg_proc WHERE pronamespace=current_schema()::regnamespace)`).Scan(&objects); err != nil || objects != 0 {
		t.Fatal("失败基线留下序列或函数", objects, err)
	}
	if got := migrationVersions(t, ctx, pool); len(got) != 0 {
		t.Fatal("失败基线被记录", got)
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal("回滚后重试失败", err)
	}
	if err := Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
}

func TestCheckRequiresExactMigrationLedger(t *testing.T) {
	pool := migratedTestDB(t)
	execOK(t, pool, `UPDATE schema_migrations SET version='unexpected-' || version`)
	if err := Check(t.Context(), pool); err == nil {
		t.Fatal("未知版本被视为迁移完成")
	}
	execOK(t, pool, `DELETE FROM schema_migrations`)
	if err := Check(t.Context(), pool); err == nil {
		t.Fatal("缺少基线记录被视为迁移完成")
	}
}

func TestMigrationLockWaitCanBeCancelledAndRetried(t *testing.T) {
	pool := openTestDB(t)
	ctx := t.Context()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", lockKey)
	waitCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	if err := Up(waitCtx, pool); err == nil || !errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
		t.Fatal("迁移未等待锁或未响应取消", err)
	}
	if tableExists(t, ctx, pool, "schema_migrations") {
		t.Fatal("取得迁移锁前创建了迁移记录表")
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", lockKey); err != nil {
		t.Fatal(err)
	}
	if err := Up(ctx, pool); err != nil {
		t.Fatal("释放锁后重试失败", err)
	}
	if err := Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
}

func TestBaselineUsesCurrentSchemaWithFallbackSearchPath(t *testing.T) {
	fallback := migratedTestDB(t)
	pool := openTestDB(t)
	ctx := t.Context()
	var current, fallbackSchema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&current); err != nil {
		t.Fatal(err)
	}
	if err := fallback.QueryRow(ctx, "SELECT current_schema()").Scan(&fallbackSchema); err != nil {
		t.Fatal(err)
	}
	before := schemaFingerprint(t, ctx, fallback)
	cfg := pool.Config()
	afterConnect := cfg.AfterConnect
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		if err := afterConnect(ctx, conn); err != nil {
			return err
		}
		_, err := conn.Exec(ctx, "SET search_path TO "+pgx.Identifier{current}.Sanitize()+", "+pgx.Identifier{fallbackSchema}.Sanitize()+", public")
		return err
	}
	withFallback, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer withFallback.Close()
	if err := Up(ctx, withFallback); err != nil {
		t.Fatal(err)
	}
	if err := Check(ctx, withFallback); err != nil {
		t.Fatal(err)
	}
	for _, table := range currentTables {
		assertInSchema(t, ctx, pool, table)
	}
	var foreignKeys int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
		WHERE c.connamespace=current_schema()::regnamespace AND c.contype='f' AND r.relnamespace<>c.connamespace`).Scan(&foreignKeys); err != nil || foreignKeys != 0 {
		t.Fatal("外键引用了其他 schema", foreignKeys, err)
	}
	assertFunctionSchema(t, ctx, pool, "reject_project_history_mutation")
	if after := schemaFingerprint(t, ctx, fallback); after != before {
		t.Fatal("基线修改了 search_path 中的后备 schema")
	}
}

func migratedTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := openTestDB(t)
	if err := Up(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	if err := Check(t.Context(), pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func execOK(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(redact.Scrub(err.Error()))
	}
}

func execFails(t *testing.T, pool *pgxpool.Pool, code, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(t.Context(), sql, args...)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Fatalf("预期 SQLSTATE %s，实际: %s", code, redact.Scrub(errorText(err)))
	}
}

func openTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("BATON_TEST_DATABASE_URL"))
	if raw == "" {
		raw = defaultTestDatabaseURL
	}
	var rawID [8]byte
	if _, err := rand.Read(rawID[:]); err != nil {
		t.Fatal(err)
	}
	schema := "m" + hex.EncodeToString(rawID[:])
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, raw, schema)
	if err != nil {
		t.Fatalf("打开测试数据库失败: %s", redact.Scrub(err.Error()))
	}
	var current string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&current); err != nil {
		pool.Close()
		t.Fatalf("读取 schema 失败: %s", redact.Scrub(err.Error()))
	}
	if current != schema {
		pool.Close()
		t.Fatalf("当前 schema 为 %s", current)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer ccancel()
		var tables, funcs int
		if err := pool.QueryRow(cctx, `
			SELECT COUNT(*) FROM information_schema.tables
			WHERE table_schema = 'public'
			  AND table_name = ANY($1)`, publicTables).Scan(&tables); err != nil {
			t.Errorf("检查 public 表失败: %s", redact.Scrub(err.Error()))
		} else if tables != 0 {
			t.Errorf("迁移写入了 public，共 %d 张表", tables)
		}
		if err := pool.QueryRow(cctx, `
			SELECT COUNT(*) FROM pg_proc p
			JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'public' AND p.proname = ANY($1)`, publicFuncs).Scan(&funcs); err != nil {
			t.Errorf("检查 public 函数失败: %s", redact.Scrub(err.Error()))
		} else if funcs != 0 {
			t.Errorf("迁移写入了 public 函数，共 %d 个", funcs)
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

var currentTables = []string{
	"employees", "login_sessions", "schema_migrations",
	"node_enrollments", "nodes", "node_credentials", "employee_settings",
	"node_presence", "node_revocations", "node_runtime_reports",
	"projects", "project_agents", "conversations", "conversation_events",
	"project_agent_input_queue", "project_memory_entries", "project_memory_revisions", "agent_runs",
	"threads", "thread_messages", "thread_turns", "thread_replies", "thread_events", "thread_outbox", "thread_reports",
	"attention_requests",
}

var retiredTables = []string{
	"tasks", "executions", "sessions", "task_events", "task_relations", "task_acceptances",
	"dispatch_outbox", "request_tombstones", "child_deliveries", "delivery_records", "task_result_refs", "execution_stops",
	"push_subscriptions", "push_deliveries",
}

var publicTables = append(append(append([]string{}, currentTables...), retiredTables...),
	"widget", "kept", "doomed", "once_run", "should_not_exist")

var publicFuncs = []string{"reject_project_history_mutation", "widget_note", "widget_label"}

func tableExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = $1
		)`, name).Scan(&exists); err != nil {
		t.Fatalf("检查表 %s 失败: %s", name, redact.Scrub(err.Error()))
	}
	return exists
}

func assertInSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table string) {
	t.Helper()
	if !tableExists(t, ctx, pool, table) {
		t.Fatalf("表 %s 不在当前 schema", table)
	}
}

func assertFunctionSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) {
	t.Helper()
	var schema string
	err := pool.QueryRow(ctx, `
		SELECT n.nspname
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE p.proname = $1 AND n.nspname = current_schema()`, name).Scan(&schema)
	if err != nil {
		t.Fatalf("函数 %s 不在当前 schema: %s", name, redact.Scrub(err.Error()))
	}
}

func assertTriggerSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name string) {
	t.Helper()
	var schema string
	err := pool.QueryRow(ctx, `
		SELECT n.nspname
		FROM pg_trigger tg
		JOIN pg_class c ON c.oid = tg.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE tg.tgname = $1 AND NOT tg.tgisinternal AND n.nspname = current_schema()`, name).Scan(&schema)
	if err != nil {
		t.Fatalf("触发器 %s 不在当前 schema: %s", name, redact.Scrub(err.Error()))
	}
}

func migrationVersions(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		t.Fatalf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			t.Fatalf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
		}
		got = append(got, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("读取迁移记录失败: %s", redact.Scrub(err.Error()))
	}
	return got
}

func schemaFingerprint(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	var b strings.Builder
	dump := func(title, sql string) {
		t.Helper()
		rows, err := pool.Query(ctx, sql)
		if err != nil {
			t.Fatalf("%s: %s", title, redact.Scrub(err.Error()))
		}
		defer rows.Close()
		b.WriteString(title)
		b.WriteByte('\n')
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatalf("%s: %s", title, redact.Scrub(err.Error()))
			}
			b.WriteString(line)
			b.WriteByte('\n')
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("%s: %s", title, redact.Scrub(err.Error()))
		}
	}
	dump("columns", `
		SELECT table_name || ':' || column_name || ':' || data_type || ':' || udt_name || ':' || is_nullable || ':' || COALESCE(column_default, '')
		FROM information_schema.columns
		WHERE table_schema = current_schema()
		ORDER BY table_name, ordinal_position`)
	dump("constraints", `
		SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
		ORDER BY 1`)
	dump("indexes", `
		SELECT indexname || ':' || indexdef
		FROM pg_indexes
		WHERE schemaname = current_schema()
		ORDER BY 1`)
	dump("sequences", `
		SELECT sequencename || ':' || data_type::text || ':' || start_value || ':' || min_value || ':' || max_value || ':' || increment_by || ':' || cycle || ':' || cache_size
		FROM pg_sequences WHERE schemaname = current_schema()
		ORDER BY 1`)
	dump("functions", `
		SELECT p.proname || ':' || pg_get_functiondef(p.oid)
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = current_schema()
		ORDER BY 1`)
	dump("triggers", `
		SELECT c.relname || ':' || pg_get_triggerdef(tg.oid)
		FROM pg_trigger tg
		JOIN pg_class c ON c.oid = tg.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND NOT tg.tgisinternal
		ORDER BY 1`)
	dump("migrations", `
		SELECT version || ' ' || applied_at::text
		FROM schema_migrations
		ORDER BY version`)
	return b.String()
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

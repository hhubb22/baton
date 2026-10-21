package migrate

import (
	"io/fs"
	"testing"
	"testing/fstest"

	"baton/migrations"
)

func TestInboxUpgradeExistingDatabaseAndRepeat(t *testing.T) {
	pool := openTestDB(t)
	ctx := t.Context()
	before := fstest.MapFS{}
	names, err := Versions()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name == "0018_attention_requests.sql" || name >= "0025_" {
			continue
		}
		body, err := fs.ReadFile(migrations.Files, name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = &fstest.MapFile{Data: body}
	}
	if err = upFS(ctx, pool, before); err != nil {
		t.Fatal(err)
	}
	// 0019 已在数据库中，0018 仍应补入并可重复执行。
	if err = Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err = Check(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if !tableExists(t, ctx, pool, "attention_requests") {
		t.Fatal("缺少事项表")
	}
	assertInSchema(t, ctx, pool, "attention_requests")
	for _, name := range []string{"push_subscriptions", "push_deliveries"} {
		if tableExists(t, ctx, pool, name) {
			t.Fatal("创建了推送表", name)
		}
	}
	fingerprint := schemaFingerprint(t, ctx, pool)
	if err = Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if fingerprint != schemaFingerprint(t, ctx, pool) {
		t.Fatal("重复迁移改变结构")
	}
}

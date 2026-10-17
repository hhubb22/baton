package db_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"baton/internal/db"
)

func TestInvalidDatabaseConfigDoesNotExposePassword(t *testing.T) {
	for name, dsn := range map[string]string{
		"unterminated":  `host=127.0.0.1 password='synthetic-prefix synthetic-tail`,
		"escaped_quote": `host=127.0.0.1 password='synthetic-prefix\' synthetic-tail' connect_timeout=invalid`,
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			pool, err := db.Open(ctx, dsn, "public")
			cancel()
			if pool != nil {
				pool.Close()
				t.Fatal("无效配置创建了连接池")
			}
			if err == nil || !strings.Contains(err.Error(), "解析数据库配置失败") {
				t.Fatal("无效配置未返回解析错误")
			}
			for _, fragment := range []string{"synthetic-prefix", "synthetic-tail"} {
				if strings.Contains(err.Error(), fragment) {
					t.Fatal("数据库配置解析错误泄露了口令片段")
				}
			}
		})
	}
}

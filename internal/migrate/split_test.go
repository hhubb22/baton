package migrate

import "testing"

func TestSplitSQLSkipsComments(t *testing.T) {
	sql := "-- comment;\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n"
	got := splitSQL(sql)
	if len(got) != 2 {
		t.Fatalf("语句数量 = %d", len(got))
	}
	if got[0] != "CREATE TABLE t (id int)" || got[1] != "INSERT INTO t VALUES (1)" {
		t.Fatalf("语句拆分错误: %#v", got)
	}
}

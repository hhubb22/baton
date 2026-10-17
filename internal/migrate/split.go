package migrate

import "strings"

func splitSQL(sql string) []string {
	var b strings.Builder
	var stmts []string
	inSingle := false
	inLineComment := false
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		if inLineComment {
			if c == '\n' {
				inLineComment = false
			}
			continue
		}
		if !inSingle && c == '-' && i+1 < len(sql) && sql[i+1] == '-' {
			inLineComment = true
			i++
			continue
		}
		if c == '\'' {
			// SQL 用两个单引号表示转义。这里的迁移文件不依赖字符串里的分号。
			if inSingle && i+1 < len(sql) && sql[i+1] == '\'' {
				b.WriteByte(c)
				b.WriteByte(sql[i+1])
				i++
				continue
			}
			inSingle = !inSingle
			b.WriteByte(c)
			continue
		}
		if c == ';' && !inSingle {
			if s := strings.TrimSpace(b.String()); s != "" {
				stmts = append(stmts, s)
			}
			b.Reset()
			continue
		}
		b.WriteByte(c)
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		stmts = append(stmts, s)
	}
	return stmts
}

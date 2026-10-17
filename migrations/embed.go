// Package migrations 存放 Coordinator 的版本化 SQL。
package migrations

import "embed"

//go:embed *.sql
var Files embed.FS

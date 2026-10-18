//go:build !windows

// Package privatefiletest 提供秘密文件的跨平台权限夹具。
package privatefiletest

import (
	"os"
	"testing"
)

func AssertPrivate(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	want := os.FileMode(0o600)
	if info.IsDir() {
		want = 0o700
	}
	if info.Mode().Perm() != want {
		t.Fatalf("权限为 %o，期望 %o", info.Mode().Perm(), want)
	}
}

func MakePublic(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
}

package privatefile_test

import (
	"os"
	"path/filepath"
	"testing"

	"baton/internal/privatefile"
	"baton/internal/privatefiletest"
)

func TestPrivateFileRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := privatefile.ProtectDir(dir); err != nil {
		t.Fatal(err)
	}
	privatefiletest.AssertPrivate(t, dir)
	if err := privatefile.CheckDir(dir); err != nil {
		t.Fatal(err)
	}
	f, err := privatefile.CreateTemp(dir, "test-")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	privatefiletest.AssertPrivate(t, f.Name())
	path := filepath.Join(dir, "secret")
	for _, content := range []string{"first", "replacement"} {
		if err := privatefile.WriteFile(path, []byte(content)); err != nil {
			t.Fatal(err)
		}
		privatefiletest.AssertPrivate(t, path)
		raw, err := privatefile.ReadFile(path)
		if err != nil || string(raw) != content {
			t.Fatalf("读取受限文件失败: %v", err)
		}
	}
	privatefiletest.MakePublic(t, path)
	if _, err := privatefile.ReadFile(path); err == nil {
		t.Fatal("接受了其他用户可读的秘密文件")
	}
}

func TestPrivateFileRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secret")
	if err := privatefile.WriteFile(path, []byte("original")); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := privatefile.ReadFile(link); err == nil {
		t.Fatal("读取了符号链接")
	}
	if err := privatefile.WriteFile(link, []byte("replacement")); err == nil {
		t.Fatal("覆盖了符号链接")
	}
	raw, err := privatefile.ReadFile(path)
	if err != nil || string(raw) != "original" {
		t.Fatal("符号链接的目标被改动")
	}
}

func TestProtectDirPreservesChildAccess(t *testing.T) {
	dir := t.TempDir()
	child := filepath.Join(dir, "existing")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(child, "secret")
	if err := os.WriteFile(path, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := privatefile.ProtectDir(dir); err != nil {
			t.Fatal(err)
		}
		privatefiletest.AssertPrivate(t, dir)
		if err := os.WriteFile(filepath.Join(child, "new"), []byte("after"), 0o600); err != nil {
			t.Fatalf("保护父目录后无法写入已有子目录: %v", err)
		}
		if _, err := os.ReadFile(path); err != nil {
			t.Fatalf("保护父目录后无法读取已有文件: %v", err)
		}
	}
}

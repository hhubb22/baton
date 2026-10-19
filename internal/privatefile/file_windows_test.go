package privatefile_test

import (
	"bytes"
	"errors"
	"io"
	"path/filepath"
	"testing"

	"baton/internal/privatefile"
	"baton/internal/privatefiletest"

	"golang.org/x/sys/windows"
)

func TestOpenAllowsAtomicReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "project-exec.json")
	oldContent := bytes.Repeat([]byte("old-content\n"), 8192)
	newContent := bytes.Repeat([]byte("new-content\n"), 4096)
	if err := privatefile.WriteFile(path, oldContent); err != nil {
		t.Fatal(err)
	}
	reader, err := privatefile.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	// 在两次读取之间替换路径，读句柄始终保留同一文件版本。
	prefix := make([]byte, 17)
	if _, err := io.ReadFull(reader, prefix); err != nil {
		t.Fatal(err)
	}
	if err := privatefile.WriteFile(path, newContent); err != nil {
		t.Fatalf("持有读句柄时原子替换失败: %v", err)
	}
	rest, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(append(prefix, rest...), oldContent) {
		t.Fatalf("读句柄未保留完整旧版本: %v", err)
	}
	current, err := privatefile.ReadFile(path)
	if err != nil || !bytes.Equal(current, newContent) {
		t.Fatalf("重新打开未读到完整新版本: %v", err)
	}
	privatefiletest.AssertPrivate(t, path)
}

func TestOpenPreventsInPlaceWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	if err := privatefile.WriteFile(path, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	reader, err := privatefile.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err == nil {
		windows.CloseHandle(handle)
		t.Fatal("读句柄存续期间允许原地写入")
	}
	if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Fatalf("未得到原地写入共享冲突: %v", err)
	}
}

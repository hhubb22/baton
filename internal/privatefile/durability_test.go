package privatefile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDirectorySyncFailureRetainsReplacementAndCanRetry(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "output.json")
	if err := WriteFile(path, []byte("old")); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("directory sync failed")
	calls := 0
	err := writeFile(path, []byte("complete replacement"), func(target string) error {
		calls++
		if target != path {
			t.Fatalf("同步了错误目录的文件: %s", target)
		}
		// 父目录同步发生在新版本可从目标路径完整读取之后。
		raw, err := ReadFile(target)
		if err != nil || string(raw) != "complete replacement" {
			t.Fatalf("替换完成前同步了目录: %q %v", raw, err)
		}
		return failure
	})
	if !errors.Is(err, failure) || calls != 1 {
		t.Fatalf("目录同步失败没有返回调用方: calls=%d err=%v", calls, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "output.json" {
		t.Fatalf("原子替换遗留了临时文件: %v %v", entries, err)
	}
	if err := WriteFile(path, []byte("complete replacement")); err != nil {
		t.Fatalf("同步结果不确定后无法安全重试: %v", err)
	}
	raw, err := ReadFile(path)
	if err != nil || string(raw) != "complete replacement" {
		t.Fatalf("重试改变了完成记录: %q %v", raw, err)
	}
}

func TestFailedReplacementDoesNotSyncDirectoryOrLeaveTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "existing-directory")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(path, []byte("result"), func(string) error {
		t.Fatal("替换失败后仍同步目录")
		return nil
	}); err == nil {
		t.Fatal("目录被替换为文件")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || !entries[0].IsDir() {
		t.Fatalf("替换失败后破坏了原目录或遗留临时文件: %v %v", entries, err)
	}
}

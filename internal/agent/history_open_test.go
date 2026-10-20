package agent

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestHistoryOpenRegularFileAndRejectsInvalidTargets(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "outside.jsonl"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	rootDir := filepath.Join(dir, "history")
	if err := os.Mkdir(rootDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "session.jsonl"), []byte("history"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()

	file, err := OpenHistoryFile(root, "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	content, err := io.ReadAll(file)
	if err != nil || string(content) != "history" {
		t.Fatalf("历史文件内容不符: %q, %v", content, err)
	}
	for _, rel := range []string{".", "missing.jsonl", "../outside.jsonl"} {
		t.Run(rel, func(t *testing.T) {
			file, err := OpenHistoryFile(root, rel)
			if file != nil {
				file.Close()
				t.Fatal("拒绝目标时仍返回了文件")
			}
			if err == nil {
				t.Fatal("接受了目录、不存在的文件或根目录外的路径")
			}
			if rel == "." && !errors.Is(err, ErrHistoryUnread) {
				t.Fatalf("目录错误未归为历史不可读: %v", err)
			}
			if rel == "missing.jsonl" && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("丢失了文件不存在的错误: %v", err)
			}
		})
	}
}

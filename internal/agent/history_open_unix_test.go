//go:build unix

package agent

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestHistoryOpenRejectsFIFOWithoutWriter(t *testing.T) {
	dir := t.TempDir()
	pipe := filepath.Join(dir, "history.jsonl")
	if err := syscall.Mkfifo(pipe, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("history.jsonl", filepath.Join(dir, "link.jsonl")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, rel := range []string{"history.jsonl", "link.jsonl", "."} {
		t.Run(rel, func(t *testing.T) {
			done := make(chan error, 1)
			go func() {
				f, err := OpenHistoryFile(root, rel)
				if f != nil {
					f.Close()
				}
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("接受了特殊文件或目录")
				}
			case <-time.After(2 * time.Second):
				// 放行阻塞的读端，避免失败用例留下 goroutine。
				fd, err := syscall.Open(pipe, syscall.O_RDWR|syscall.O_NONBLOCK, 0)
				if err == nil {
					defer syscall.Close(fd)
					<-done
				}
				t.Fatal("特殊文件阻塞了历史查询")
			}
		})
	}
}

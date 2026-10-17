//go:build unix

package node

import (
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"baton/internal/protocol"
)

func TestBrowseRejectsFIFOAndSocketWithinOneSecond(t *testing.T) {
	dir := t.TempDir()
	// Unix socket 路径在 macOS 上限 104 字节，t.TempDir() 太长，浏览根放在 /tmp 下的短目录。
	short, err := os.MkdirTemp("/tmp", "bt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(short) })
	if short, err = filepath.EvalSymlinks(short); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(short, "notes")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(root, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(root, "echo.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	if err := os.WriteFile(filepath.Join(root, "plain.txt"), []byte("PLAINTEXT"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}

	listed := browseWithin(t, time.Second, dir, fileReq("notes", "", ""))
	if !listed.OK || listed.Kind != protocol.FileKindDirectory {
		t.Fatalf("目录没有列出: %+v", listed)
	}
	kinds := map[string]string{}
	for _, entry := range listed.Entries {
		kinds[entry.Name] = entry.Kind
	}
	if kinds["pipe"] != protocol.FileKindFIFO || kinds["echo.sock"] != protocol.FileKindSocket || kinds["plain.txt"] != protocol.FileKindFile {
		t.Fatalf("特殊文件类型不正确: %+v", kinds)
	}

	pipe := browseWithin(t, time.Second, dir, fileReq("notes", "pipe", ""))
	if pipe.OK || pipe.Code != protocol.FileCodeUnsupported || pipe.Content != nil {
		t.Fatalf("FIFO 没有被拒绝: %+v", pipe)
	}
	sock := browseWithin(t, time.Second, dir, fileReq("notes", "echo.sock", ""))
	if sock.OK || sock.Code != protocol.FileCodeUnsupported || sock.Content != nil {
		t.Fatalf("套接字没有被拒绝: %+v", sock)
	}
	plain := browseWithin(t, time.Second, dir, fileReq("notes", "plain.txt", ""))
	if !plain.OK || plain.Content == nil || *plain.Content != "PLAINTEXT" {
		t.Fatalf("普通文件被误拒: %+v", plain)
	}
}

func TestBrowseRejectsFileReplacedWithFIFO(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "notes")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "swap.txt")
	if err := os.WriteFile(target, []byte("PLAINTEXT"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AddBrowseRoot(dir, "notes", root); err != nil {
		t.Fatal(err)
	}
	before := browseWithin(t, time.Second, dir, fileReq("notes", "swap.txt", ""))
	if !before.OK || before.Content == nil || *before.Content != "PLAINTEXT" {
		t.Fatalf("替换前没有读到普通文件: %+v", before)
	}
	real := target + ".real"
	if err := os.Rename(target, real); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(target, 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		replaced := browseWithin(t, time.Second, dir, fileReq("notes", "swap.txt", ""))
		if replaced.OK || replaced.Code != protocol.FileCodeUnsupported || replaced.Content != nil {
			t.Fatalf("第 %d 次把普通文件换成 FIFO 后没有被拒绝: %+v", i, replaced)
		}
		if err := os.Remove(target); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(real, target); err != nil {
			t.Fatal(err)
		}
		restored := browseWithin(t, time.Second, dir, fileReq("notes", "swap.txt", ""))
		if !restored.OK || restored.Content == nil || *restored.Content != "PLAINTEXT" {
			t.Fatalf("第 %d 次恢复普通文件后没有读到原文: %+v", i, restored)
		}
		if err := os.Rename(target, real); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(target, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(real, target); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		held := target + ".held"
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := os.Rename(target, held); err != nil {
				continue
			}
			if err := syscall.Mkfifo(target, 0o600); err != nil {
				_ = os.Rename(held, target)
				continue
			}
			time.Sleep(time.Millisecond)
			_ = os.Remove(target)
			_ = os.Rename(held, target)
		}
	}()
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		result := browseWithin(t, time.Second, dir, fileReq("notes", "swap.txt", ""))
		if result.Content != nil && *result.Content != "PLAINTEXT" {
			close(stop)
			wg.Wait()
			t.Fatalf("打开期间换成 FIFO 后读到了意外内容: %+v", result)
		}
		if result.OK || result.Code == protocol.FileCodeUnsupported || result.Code == protocol.FileCodeNotFound {
			continue
		}
		close(stop)
		wg.Wait()
		t.Fatalf("打开期间换成 FIFO 后的结果不正确: %+v", result)
	}
	close(stop)
	wg.Wait()
}

func browseWithin(t *testing.T, limit time.Duration, dir string, req protocol.FileRequest) protocol.FileResult {
	t.Helper()
	done := make(chan protocol.FileResult, 1)
	started := time.Now()
	go func() {
		done <- Browse(dir, req)
	}()
	select {
	case result := <-done:
		if elapsed := time.Since(started); elapsed > limit {
			t.Fatalf("浏览 %s 耗时 %s", req.Path, elapsed)
		}
		return result
	case <-time.After(limit):
		t.Fatalf("浏览 %s 在 %s 内没有返回", req.Path, limit)
		return protocol.FileResult{}
	}
}

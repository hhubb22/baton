package kiro

import (
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestBlockedProtocolWriteHasDeadline(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	stopped := make(chan struct{})
	p := &processIO{ReadCloser: reader, WriteCloser: writer, writeTimeout: 20 * time.Millisecond, stopTree: func() { close(stopped) }}
	done := make(chan error, 1)
	go func() { _, err := p.Write(make([]byte, 256*1024)); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("未读管道写入成功")
		}
	case <-time.After(time.Second):
		t.Fatal("协议写入没有释放")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("写入超时没有停止进程树")
	}
}

type processBoundReader struct {
	io.Reader
	exited <-chan struct{}
}

func (r processBoundReader) Close() error {
	// Windows 同步管道的 Close 会等待仍在执行的 ReadFile。
	<-r.exited
	return nil
}

func TestProcessCloseKillsBeforeClosingPipe(t *testing.T) {
	if os.Getenv("BATON_TEST_KIRO_CLOSE_CHILD") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessCloseKillsBeforeClosingPipe$")
	cmd.Env = append(os.Environ(), "BATON_TEST_KIRO_CLOSE_CHILD=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })
	reader, writer := io.Pipe()
	defer reader.Close()
	p := &processIO{ReadCloser: processBoundReader{Reader: strings.NewReader(""), exited: exited}, WriteCloser: writer, stopTree: func() { _ = cmd.Process.Kill() }}
	done := make(chan struct{})
	go func() { _ = p.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("关闭管道前未终止子进程")
	}
}

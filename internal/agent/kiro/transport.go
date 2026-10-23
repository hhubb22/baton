package kiro

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/sourcegraph/jsonrpc2"
)

const maxFrame = 8 * 1024 * 1024

// ACP 使用 LF 分帧，帧内 Unicode 行分隔符保持原样。
type lineCodec struct{}

func (lineCodec) WriteObject(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }
func (lineCodec) ReadObject(r *bufio.Reader, v any) error {
	var frame []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(frame)+len(part) > maxFrame {
			return errors.New("Kiro 协议帧超过本地上限")
		}
		frame = append(frame, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return err
		}
		return json.Unmarshal(frame, v)
	}
}

type processIO struct {
	io.ReadCloser
	io.WriteCloser
	stopTree     func()
	once         sync.Once
	writeTimeout time.Duration
}

// jsonrpc2 的写入不消费 context；期限到达直接关闭管道，释放写者与控制锁。
func (p *processIO) Write(data []byte) (int, error) {
	timeout := p.writeTimeout
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	timer := time.AfterFunc(timeout, func() { _ = p.Close() })
	defer timer.Stop()
	n, err := p.WriteCloser.Write(data)
	if err != nil {
		_ = p.Close()
	}
	return n, err
}

func (p *processIO) Close() error {
	p.once.Do(func() {
		// Windows 同步管道的关闭会等待读写结束，先终止进程树以释放这些操作。
		if p.stopTree != nil {
			p.stopTree()
		}
		_ = p.WriteCloser.Close()
		_ = p.ReadCloser.Close()
	})
	return nil
}

var _ jsonrpc2.ObjectCodec = lineCodec{}

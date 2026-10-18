package codex

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"sync"

	"github.com/sourcegraph/jsonrpc2"
)

const maxFrame = 8 * 1024 * 1024

// Codex uses LF-delimited JSON, not terminal lines or LSP Content-Length.
type lineCodec struct{}

func (lineCodec) WriteObject(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }
func (lineCodec) ReadObject(r *bufio.Reader, v any) error {
	var frame []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(frame)+len(part) > maxFrame {
			return errors.New("Codex protocol frame exceeds local limit")
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
	cmd  *exec.Cmd
	once sync.Once
}

func (p *processIO) Close() error {
	p.once.Do(func() {
		_ = p.WriteCloser.Close()
		_ = p.ReadCloser.Close()
		_ = p.cmd.Process.Kill()
	})
	return nil
}

var _ jsonrpc2.ObjectCodec = lineCodec{}

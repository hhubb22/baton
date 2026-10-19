package sidecar

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
)

type boundedOutput struct {
	bytes.Buffer
	limit    int
	overflow bool
	cancel   context.CancelFunc
}

func (b *boundedOutput) Write(raw []byte) (int, error) {
	n := len(raw)
	if b.Len()+n > b.limit {
		b.overflow = true
		b.cancel()
	}
	b.Buffer.Write(raw[:min(n, b.limit-b.Len())])
	return n, nil
}

// Capture 限制诊断/探测输出，超时和超限时回收整棵进程树。
func Capture(ctx context.Context, cmd *exec.Cmd, limit int) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	output := &boundedOutput{limit: limit, cancel: cancel}
	cmd.Stdout = output
	process, err := Start(cmd)
	if err != nil {
		return nil, err
	}
	defer process.Stop()
	select {
	case <-ctx.Done():
		process.Stop()
		err = process.Wait()
		if err == nil {
			err = ctx.Err()
		}
	case <-process.done:
		err = process.Wait()
	}
	if output.overflow {
		return nil, errors.New("sidecar 输出超过容量")
	}
	return output.Bytes(), err
}

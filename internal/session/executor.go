package session

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
)

// Observer 是仅供测试观察的执行器。准备阶段不能调用 Start 或 RunStartupHooks。
type Observer struct {
	path   string
	starts atomic.Int64
	hooks  atomic.Int64
}

func NewObserver(path string) *Observer {
	return &Observer{path: strings.TrimSpace(path)}
}

func (o *Observer) Starts() int64 {
	if o == nil {
		return 0
	}
	return o.starts.Load()
}

func (o *Observer) Hooks() int64 {
	if o == nil {
		return 0
	}
	return o.hooks.Load()
}

func (o *Observer) Start(context.Context) error {
	if o == nil {
		return errors.New("没有执行器")
	}
	o.starts.Add(1)
	return o.record("start")
}

func (o *Observer) RunStartupHooks(context.Context) error {
	if o == nil {
		return errors.New("没有执行器")
	}
	o.hooks.Add(1)
	return o.record("hook")
}

func (o *Observer) record(line string) error {
	if o.path == "" {
		return nil
	}
	f, err := os.OpenFile(o.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line + "\n")
	return err
}

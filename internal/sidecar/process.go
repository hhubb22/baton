package sidecar

import (
	"os/exec"
	"sync"
)

// Process 在整棵进程树回收后通知调用者。恢复所需的新运行身份由调用者决定。
type Process struct {
	done chan struct{}
	stop func()
	once sync.Once
	err  error
}

func Start(cmd *exec.Cmd) (*Process, error) {
	stop, err := StartTree(cmd)
	if err != nil {
		return nil, err
	}
	p := &Process{done: make(chan struct{}), stop: stop}
	go func() { p.err = cmd.Wait(); p.Stop(); close(p.done) }()
	return p, nil
}
func (p *Process) Stop()       { p.once.Do(p.stop) }
func (p *Process) Wait() error { <-p.done; return p.err }

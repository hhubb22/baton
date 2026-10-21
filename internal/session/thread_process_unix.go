//go:build !windows

package session

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type threadProcess struct {
	pid, parent, group int
	zombie             bool
}

func threadProcesses() ([]threadProcess, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,ppid=,pgid=,stat=").Output()
	if err != nil {
		return nil, err
	}
	var processes []threadProcess
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, e1 := strconv.Atoi(fields[0])
		parent, e2 := strconv.Atoi(fields[1])
		group, e3 := strconv.Atoi(fields[2])
		if e1 != nil || e2 != nil || e3 != nil {
			return nil, fmt.Errorf("无法读取 Agent 进程树")
		}
		processes = append(processes, threadProcess{pid, parent, group, strings.HasPrefix(fields[3], "Z")})
	}
	return processes, nil
}

// killThreadChildren 只用于每个 Thread 独占的 Worker 进程。
// Agent 的独立进程组覆盖 fork 的后代；脱离进程组的外部服务由员工管理。
func killThreadChildren() (bool, error) {
	processes, err := threadProcesses()
	if err != nil {
		return false, err
	}
	owned := map[int]bool{os.Getpid(): true}
	for changed := true; changed; {
		changed = false
		for _, p := range processes {
			if owned[p.parent] && !owned[p.pid] {
				owned[p.pid] = true
				changed = true
			}
		}
	}
	ownGroup, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		return false, err
	}
	groups := map[int]bool{}
	targets := map[int]bool{}
	for _, p := range processes {
		if !owned[p.pid] || p.pid == os.Getpid() || p.zombie {
			continue
		}
		targets[p.pid] = true
		if p.group > 0 && p.group != ownGroup {
			groups[p.group] = true
		}
	}
	for group := range groups {
		if err := syscall.Kill(-group, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			return false, err
		}
	}
	for pid := range targets {
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
			return false, err
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		current, err := threadProcesses()
		if err != nil {
			return false, err
		}
		alive := false
		for _, p := range current {
			if !p.zombie && (targets[p.pid] || groups[p.group]) {
				alive = true
				break
			}
		}
		if !alive {
			return true, nil
		}
		if time.Now().After(deadline) {
			return false, nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Package shell 把节点命令接入统一的 Agent 生命周期。
package shell

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/privatefile"
	"baton/internal/projectexec"
	"baton/internal/sidecar"
)

type Adapter struct {
	messageID                           string
	events                              []agent.Event
	config                              agent.Config
	mu                                  sync.Mutex
	started, submitted, closed, stopped bool
	process                             *sidecar.Process
	done                                chan struct{}
	aborted                             bool
	pending                             *completionRecord
	restorePending, maintaining         bool
	retryAt                             time.Time
	failures                            int
	diagnostic                          *agent.Event
	lastError                           string
	readFile                            func(string) ([]byte, error)
	writeFile                           func(string, []byte) error
	now                                 func() time.Time
}

func New(config agent.Config) *Adapter {
	return &Adapter{config: config, readFile: readCompletionFile, writeFile: privatefile.WriteFile, now: time.Now}
}

func (a *Adapter) Start(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.started {
		return errors.New("命令执行器状态无效")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.config.Restore {
		// 即使恢复失败，也不能把同一执行当成首次输入。
		a.submitted = true
		if err := a.validateIdentity(); err != nil {
			return fmt.Errorf("%w: %v", agent.ErrHistoryMissing, err)
		}
		record, err := a.loadCompletion()
		if err != nil {
			a.noteFailureLocked("read", err)
			if definitiveHistoryError(err) {
				return fmt.Errorf("%w: %v", agent.ErrHistoryMissing, err)
			}
			a.restorePending = true
		} else {
			a.restoreLocked(record)
		}
		a.started = true
		return nil
	}
	if err := a.validateIdentity(); err != nil {
		return err
	}
	if err := fileaccess.PrepareDataDir(a.config.SessionDir); err != nil {
		return err
	}
	a.started = true
	return nil
}

func (a *Adapter) launchLocked(ctx context.Context, command string) error {
	if ctx.Err() != nil {
		return errors.New("命令启动已取消")
	}
	// 每次启动前读取本机配置和登记目录，能力报告不能代替节点上的授权。
	cfg, err := projectexec.ReadProjectExec(a.config.DataDir)
	if err != nil || !cfg.Enabled {
		return errors.New("此节点未开启 Project Agent 命令执行")
	}
	directory, err := authorizedDirectory(a.config.DataDir, a.config.Directory)
	if err != nil {
		return errors.New("命令工作目录不存在或未登记")
	}
	args := []string{"-lc", command}
	if runtime.GOOS == "windows" {
		args = []string{"-NoProfile", "-Command", command}
	}
	binary, err := exec.LookPath(cfg.Shell)
	if err != nil {
		return errors.New("无法启动命令使用的 shell")
	}
	cmd := exec.Command(binary, args...)
	cmd.Dir = directory
	if a.config.Env != nil {
		cmd.Env = append(os.Environ(), a.config.Env...)
	}
	output := &boundedOutput{}
	cmd.Stdout, cmd.Stderr = output, output
	// 后代持有输出管道时也能回收整个进程树，避免等待管道无限阻塞。
	cmd.WaitDelay = time.Second
	process, err := sidecar.Start(cmd)
	if err != nil {
		return errors.New("无法启动命令使用的 shell")
	}
	a.process, a.done = process, make(chan struct{})
	a.events = append(a.events, agent.Event{Kind: agent.EventTurnStarted, ClientMessageID: a.messageID, NativeSessionID: a.config.SessionID})
	go func() {
		err := process.Wait()
		code := 0
		if err != nil {
			code = -1
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else if errors.Is(err, exec.ErrWaitDelay) {
				code = 0
			}
		}
		result := output.result(code)
		a.mu.Lock()
		kind := "exited"
		if a.aborted {
			kind = "stopped"
		}
		a.stopped = true
		a.queueCompletionLocked(result, kind)
		close(a.done)
		a.mu.Unlock()
	}()
	return nil
}

func authorizedDirectory(dataDir, directory string) (string, error) {
	if !filepath.IsAbs(directory) {
		return "", errors.New("工作目录必须是绝对路径")
	}
	real, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		return "", errors.New("工作目录不存在")
	}
	roots, err := fileaccess.ListBrowseRoots(dataDir)
	if err != nil {
		return "", err
	}
	for _, root := range roots {
		rootInfo, rootErr := os.Lstat(root.Path)
		if rootErr != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
			continue
		}
		registered, err := filepath.EvalSymlinks(root.Path)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(registered, real)
		if err == nil && (rel == "." || filepath.IsLocal(rel)) {
			return real, nil
		}
	}
	return "", errors.New("工作目录未登记")
}

func (a *Adapter) historyPath() string { return filepath.Join(a.config.SessionDir, "output.json") }
func (a *Adapter) ReadHistory(ctx context.Context, cursor string) (agent.HistoryPage, error) {
	if cursor != "" {
		return agent.HistoryPage{}, agent.ErrInvalidCursor
	}
	if err := ctx.Err(); err != nil {
		return agent.HistoryPage{}, err
	}
	record, err := a.loadCompletion()
	if err != nil {
		return agent.HistoryPage{}, fmt.Errorf("%w: %v", agent.ErrHistoryMissing, err)
	}
	page, _ := json.Marshal([]commandOutput{record.Result})
	return agent.HistoryPage{Data: page}, nil
}

func (a *Adapter) StopStatus() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopped, !a.submitted
}
func (a *Adapter) Abort() (bool, bool, error) {
	a.mu.Lock()
	p, done, submitted := a.process, a.done, a.submitted
	if p != nil && !a.stopped {
		a.aborted = true
	}
	if p == nil && !a.restorePending && !a.config.Restore {
		a.stopped = true
	}
	stopped := a.stopped
	a.mu.Unlock()
	if p == nil {
		return stopped, !submitted, nil
	}
	p.Stop()
	select {
	case <-done:
		return true, false, nil
	case <-time.After(5 * time.Second):
		return false, false, errors.New("等待命令进程树停止超时")
	}
}
func (a *Adapter) Close() error {
	a.mu.Lock()
	a.closed = true
	a.mu.Unlock()
	_, _, err := a.Abort()
	return err
}

const commandOutputBytes = 32 * 1024

// commandOutput 保存命令退出和合并输出事实。
type commandOutput struct {
	Encoding   string `json:"encoding,omitempty"`
	Output     string `json:"output"`
	TotalBytes int64  `json:"total_bytes"`
	ExitCode   int    `json:"exit_code"`
	Truncated  bool   `json:"truncated"`
}

type boundedOutput struct {
	head, tail []byte
	total      int64
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	b.total += int64(n)
	const half = commandOutputBytes / 2
	if len(b.head) < half {
		take := min(half-len(b.head), len(p))
		b.head = append(b.head, p[:take]...)
		p = p[take:]
	}
	if len(p) >= half {
		b.tail = append(b.tail[:0], p[len(p)-half:]...)
	} else {
		if overflow := len(b.tail) + len(p) - half; overflow > 0 {
			copy(b.tail, b.tail[overflow:])
			b.tail = b.tail[:len(b.tail)-overflow]
		}
		b.tail = append(b.tail, p...)
	}
	return n, nil
}
func (b *boundedOutput) result(code int) commandOutput {
	raw := append(append([]byte(nil), b.head...), b.tail...)
	// 二进制及控制字节用 base64 保存，避免 JSON 转义放大结果。
	encoding, text := "", string(raw)
	binary := !utf8.Valid(raw)
	for _, r := range text {
		if unicode.IsControl(r) && r != '\n' && r != '\t' && r != '\r' {
			binary = true
			break
		}
	}
	// 过多 JSON 转义会在工具结果和会话输入中继续放大，使用相同的字节编码保存。
	escaped, _ := json.Marshal(text)
	if binary || len(escaped) > 40*1024 {
		encoding, text = "base64", base64.StdEncoding.EncodeToString(raw)
	}
	return commandOutput{Encoding: encoding, Output: text, TotalBytes: b.total, ExitCode: code, Truncated: b.total > commandOutputBytes}
}

var _ agent.Adapter = (*Adapter)(nil)

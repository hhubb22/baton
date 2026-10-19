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
	"baton/internal/task"
)

type Adapter struct {
	config                              agent.Config
	mu                                  sync.Mutex
	started, submitted, closed, stopped bool
	process                             *sidecar.Process
	done                                chan struct{}
	outputs                             []agent.Output
}

func New(config agent.Config) *Adapter { return &Adapter{config: config} }

func (a *Adapter) Start(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.config.Restore {
		return agent.ErrHistoryMissing
	}
	if a.closed {
		return errors.New("命令执行器已关闭")
	}
	if err := fileaccess.PrepareDataDir(a.config.SessionDir); err != nil {
		return err
	}
	a.started = true
	return nil
}

// SubmitInput 只启动一次命令；结束结果由 Worker 的现有 Drain 轮询读取。
func (a *Adapter) SubmitInput(ctx context.Context, payload string) (agent.Output, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.started || a.closed || a.submitted {
		return agent.Output{}, errors.New("命令执行器状态无效")
	}
	a.submitted = true
	var input struct {
		Description string `json:"description"`
		Generation  int    `json:"generation"`
	}
	if len(payload) > task.ExecutorInputLimit || json.Unmarshal([]byte(payload), &input) != nil || input.Description == "" || input.Generation != 1 {
		return a.failureLocked("命令任务输入无效"), nil
	}
	if ctx.Err() != nil {
		return a.failureLocked("命令启动已取消"), nil
	}
	// 每次启动前读取本机配置和登记目录，能力报告不能代替节点上的授权。
	cfg, err := projectexec.ReadProjectExec(a.config.DataDir)
	if err != nil || !cfg.Enabled {
		return a.failureLocked("此节点未开启 Project Agent 命令执行"), nil
	}
	directory, err := authorizedDirectory(a.config.DataDir, a.config.Directory)
	if err != nil {
		return a.failureLocked("命令工作目录不存在或未登记"), nil
	}
	args := []string{"-lc", input.Description}
	if runtime.GOOS == "windows" {
		args = []string{"-NoProfile", "-Command", input.Description}
	}
	binary, err := exec.LookPath(cfg.Shell)
	if err != nil {
		return a.failureLocked("无法启动命令使用的 shell"), nil
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
		return a.failureLocked("无法启动命令使用的 shell"), nil
	}
	a.process, a.done = process, make(chan struct{})
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
		out := formatResult(result, "")
		a.mu.Lock()
		a.outputs = append(a.outputs, out)
		a.stopped = true
		_ = privatefile.WriteFile(a.historyPath(), []byte(out.Final))
		close(a.done)
		a.mu.Unlock()
	}()
	return agent.Output{}, nil
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

func (a *Adapter) failureLocked(reason string) agent.Output {
	a.stopped = true
	out := formatResult(task.CommandResult{ExitCode: -1}, reason)
	_ = privatefile.WriteFile(a.historyPath(), []byte(out.Final))
	return out
}

func formatResult(result task.CommandResult, reason string) agent.Output {
	status, summary := task.StatusCompleted, "命令已完成"
	var failure any
	if result.ExitCode != 0 {
		status, summary = task.StatusFailed, "命令执行失败"
		if reason == "" {
			reason = fmt.Sprintf("命令退出码为 %d", result.ExitCode)
		}
		failure = struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{task.CodeExecutionFailed, reason}
	}
	raw, _ := json.Marshal(struct {
		Status               string             `json:"status"`
		Summary              string             `json:"summary"`
		Evidence             []task.ResultRef   `json:"evidence"`
		Artifacts            []task.ResultRef   `json:"artifacts"`
		EvidenceEmptyReason  string             `json:"evidence_empty_reason"`
		ArtifactsEmptyReason string             `json:"artifacts_empty_reason"`
		Error                any                `json:"error"`
		Result               task.CommandResult `json:"command_result"`
	}{status, summary, []task.ResultRef{}, []task.ResultRef{}, "命令输出记录在执行结果中", "命令执行未声明文件产物", failure, result})
	return agent.Output{Final: string(raw), Exited: true}
}

func (a *Adapter) DeliverResult(context.Context, string, string) (agent.Output, error) {
	return agent.Output{}, errors.New("命令不能接收子任务结果")
}
func (a *Adapter) HistoryContains(string, bool) (bool, error) { return false, nil }
func (a *Adapter) historyPath() string                        { return filepath.Join(a.config.SessionDir, "output.json") }
func (a *Adapter) ReadHistory(ctx context.Context, cursor string) (agent.HistoryPage, error) {
	if cursor != "" {
		return agent.HistoryPage{}, agent.ErrInvalidCursor
	}
	if err := ctx.Err(); err != nil {
		return agent.HistoryPage{}, err
	}
	f, err := privatefile.Open(a.historyPath())
	if err != nil {
		return agent.HistoryPage{}, agent.ErrHistoryMissing
	}
	defer f.Close()
	var raw json.RawMessage
	if json.NewDecoder(f).Decode(&raw) != nil {
		return agent.HistoryPage{}, agent.ErrHistoryMissing
	}
	page, _ := json.Marshal([]json.RawMessage{raw})
	return agent.HistoryPage{Data: page}, nil
}
func (a *Adapter) Drain() []agent.Output {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.outputs
	a.outputs = nil
	return out
}
func (a *Adapter) StopStatus() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopped, !a.submitted
}
func (a *Adapter) Abort() (bool, bool, error) {
	a.mu.Lock()
	p, done, submitted := a.process, a.done, a.submitted
	if p == nil {
		a.stopped = true
	}
	a.mu.Unlock()
	if p == nil {
		return true, !submitted, nil
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

type boundedOutput struct {
	head, tail []byte
	total      int64
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	b.total += int64(n)
	const half = task.CommandOutputBytes / 2
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
func (b *boundedOutput) result(code int) task.CommandResult {
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
	return task.CommandResult{Encoding: encoding, Output: text, TotalBytes: b.total, ExitCode: code, Truncated: b.total > task.CommandOutputBytes}
}

var _ agent.Adapter = (*Adapter)(nil)
var _ agent.StopObserver = (*Adapter)(nil)

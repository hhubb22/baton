package shell

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/identity"
	"baton/internal/privatefile"
	"baton/internal/task"
)

const completionLimit = 192 * 1024

var errCompletion = errors.New("命令完成记录无效")

type completionRecord struct {
	SchemaVersion   int             `json:"schema_version"`
	SessionID       string          `json:"session_id"`
	ExecutionID     string          `json:"execution_id"`
	InputGeneration int             `json:"input_generation"`
	CompletionKind  string          `json:"completion_kind"`
	ProcessStopped  bool            `json:"process_stopped"`
	Result          json.RawMessage `json:"result"`
}

func (a *Adapter) validateIdentity() error {
	if _, err := identity.ParseUUID(a.config.SessionID); err != nil {
		return fmt.Errorf("%w: session_id", errCompletion)
	}
	if _, err := identity.ParseUUID(a.config.ExecutionID); err != nil {
		return fmt.Errorf("%w: execution_id", errCompletion)
	}
	return nil
}

func readCompletionFile(path string) ([]byte, error) {
	f, err := privatefile.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > completionLimit {
		return nil, fmt.Errorf("%w: 超过 %d 字节", errCompletion, completionLimit)
	}
	raw, err := io.ReadAll(io.LimitReader(f, completionLimit+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > completionLimit {
		return nil, fmt.Errorf("%w: 超过 %d 字节", errCompletion, completionLimit)
	}
	return raw, nil
}

// checkJSON 拒绝重复字段、尾随文档和无效 UTF-8，避免恢复身份有多种解释。
func checkJSON(raw []byte) error {
	if !utf8.Valid(raw) {
		return errCompletion
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value func() error
	value = func() error {
		token, err := dec.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := make(map[string]bool)
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				name = strings.ToLower(name)
				if !ok || seen[name] {
					return errCompletion
				}
				seen[name] = true
				if err := value(); err != nil {
					return err
				}
			}
		case '[':
			for dec.More() {
				if err := value(); err != nil {
					return err
				}
			}
		default:
			return errCompletion
		}
		_, err = dec.Token()
		return err
	}
	if err := value(); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errCompletion
	}
	return nil
}

func (a *Adapter) loadCompletion(restore bool) (*completionRecord, error) {
	raw, err := a.readFile(a.historyPath())
	if err != nil {
		return nil, err
	}
	if len(raw) > completionLimit || checkJSON(raw) != nil {
		return nil, fmt.Errorf("%w: JSON 或大小不合法", errCompletion)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errCompletion
	}
	record := &completionRecord{}
	if _, envelope := fields["schema_version"]; envelope {
		if len(fields) != 7 || requireFields(fields, "schema_version", "session_id", "execution_id", "input_generation", "completion_kind", "process_stopped", "result") != nil {
			return nil, fmt.Errorf("%w: 完成信封字段不完整", errCompletion)
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(record); err != nil {
			return nil, fmt.Errorf("%w: %v", errCompletion, err)
		}
		if err := a.validateIdentity(); err != nil {
			return nil, err
		}
		if record.SchemaVersion != 1 || record.SessionID != a.config.SessionID || record.ExecutionID != a.config.ExecutionID || record.InputGeneration != 1 || !record.ProcessStopped {
			return nil, fmt.Errorf("%w: 版本、执行身份、代次或停止事实不匹配", errCompletion)
		}
	} else {
		// Worker 根据账本校验持久化 Config 的 Session 和 execution；shell 只允许 generation=1。
		// 裸结果还必须位于该 Config 对应的原 Session 私有目录。
		if restore && !a.legacyBound() {
			return nil, fmt.Errorf("%w: 旧结果无法证明属于当前执行", errCompletion)
		}
		record = &completionRecord{SchemaVersion: 1, SessionID: a.config.SessionID, ExecutionID: a.config.ExecutionID, InputGeneration: 1, CompletionKind: "exited", ProcessStopped: true, Result: raw}
	}
	var resultFields, commandFields map[string]json.RawMessage
	if json.Unmarshal(record.Result, &resultFields) != nil || requireFields(resultFields, "command_result") != nil || json.Unmarshal(resultFields["command_result"], &commandFields) != nil || requireFields(commandFields, "output", "total_bytes", "exit_code", "truncated") != nil {
		return nil, fmt.Errorf("%w: 缺少命令退出或输出字段", errCompletion)
	}
	for name := range commandFields {
		switch name {
		case "encoding", "output", "total_bytes", "exit_code", "truncated":
		default:
			return nil, fmt.Errorf("%w: command_result.%s", errCompletion, name)
		}
	}
	if encoding, ok := commandFields["encoding"]; ok && bytes.Equal(bytes.TrimSpace(encoding), []byte("null")) {
		return nil, fmt.Errorf("%w: command_result.encoding", errCompletion)
	}
	candidate, err := task.ParseCandidate(string(record.Result))
	if err != nil || candidate.CommandResult == nil || (candidate.Status != task.StatusCompleted && candidate.Status != task.StatusFailed) {
		return nil, fmt.Errorf("%w: 候选命令结果不合法", errCompletion)
	}
	switch record.CompletionKind {
	case "exited", "stopped":
	case "launch_failed":
		r := candidate.CommandResult
		if candidate.Status != task.StatusFailed || r.ExitCode != -1 || r.TotalBytes != 0 {
			return nil, fmt.Errorf("%w: 启动失败事实不合法", errCompletion)
		}
	default:
		return nil, fmt.Errorf("%w: completion_kind", errCompletion)
	}
	return record, nil
}

func requireFields(fields map[string]json.RawMessage, names ...string) error {
	for _, name := range names {
		raw, ok := fields[name]
		if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return errCompletion
		}
	}
	return nil
}

func (a *Adapter) legacyBound() bool {
	if !a.config.Restore || a.config.DataDir == "" || a.validateIdentity() != nil {
		return false
	}
	session, _ := identity.ParseUUID(a.config.SessionID)
	want, err := filepath.Abs(filepath.Join(a.config.DataDir, "sessions", session, "native"))
	if err != nil {
		return false
	}
	got, err := filepath.Abs(a.config.SessionDir)
	return err == nil && got == want && privatefile.CheckDir(got) == nil && privatefile.CheckDir(filepath.Dir(got)) == nil
}

func definitiveHistoryError(err error) bool {
	if errors.Is(err, errCompletion) || os.IsNotExist(err) || errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
		return true
	}
	// 系统调用失败可以重试；权限、链接和普通文件检查产生的格式错误需待核实。
	var pathErr *os.PathError
	var syscallErr *os.SyscallError
	var errno syscall.Errno
	return !errors.As(err, &pathErr) && !errors.As(err, &syscallErr) && !errors.As(err, &errno)
}

func completionOutput(record *completionRecord) agent.Output {
	return agent.Output{Final: string(record.Result), Exited: true, Uncertain: record.CompletionKind == "stopped"}
}

func (a *Adapter) restoreLocked(record *completionRecord) {
	a.restorePending = false
	a.stopped = record.ProcessStopped
	a.outputs = append(a.outputs, completionOutput(record))
}

func (a *Adapter) queueCompletionLocked(out agent.Output, kind string) {
	a.pending = &completionRecord{SchemaVersion: 1, SessionID: a.config.SessionID, ExecutionID: a.config.ExecutionID, InputGeneration: 1, CompletionKind: kind, ProcessStopped: true, Result: json.RawMessage(out.Final)}
	a.maintainLocked()
}

// maintainLocked 只调度一次文件操作。磁盘 I/O 和重试间隔均不占用 Adapter 或 Worker 的锁。
func (a *Adapter) maintainLocked() {
	if a.maintaining || (a.pending == nil && !a.restorePending) || a.now().Before(a.retryAt) {
		return
	}
	a.maintaining = true
	pending := a.pending
	go func() {
		var record *completionRecord
		var err error
		op := "read"
		if pending != nil {
			op = "save"
			var raw []byte
			raw, err = json.Marshal(pending)
			if err == nil && len(raw) > completionLimit {
				err = fmt.Errorf("%w: 保存超过大小上限", errCompletion)
			}
			if err == nil {
				err = a.writeFile(a.historyPath(), raw)
			}
		} else {
			record, err = a.loadCompletion(true)
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		a.maintaining = false
		if err != nil {
			a.noteFailureLocked(op, err)
			if pending == nil && definitiveHistoryError(err) {
				a.restorePending = false
				a.outputs = append(a.outputs, agent.Output{Uncertain: true})
			}
			return
		}
		a.failures, a.lastError, a.retryAt = 0, "", time.Time{}
		if pending != nil {
			a.outputs = append(a.outputs, completionOutput(pending))
			a.pending = nil
		} else {
			a.restoreLocked(record)
		}
	}()
}

func (a *Adapter) noteFailureLocked(op string, err error) {
	a.failures++
	delay := min(100*time.Millisecond*time.Duration(1<<min(a.failures-1, 6)), 5*time.Second)
	a.retryAt = a.now().Add(delay)
	a.lastError = fmt.Sprintf("shell completion %s failed (attempt %d, retry in %s): %v", op, a.failures, delay, err)
	raw, _ := json.Marshal(struct {
		Type       string `json:"type"`
		Operation  string `json:"operation"`
		Attempt    int    `json:"attempt"`
		Persistent bool   `json:"persistent"`
		Error      string `json:"error"`
	}{"shell_completion_error", op, a.failures, a.failures > 1, err.Error()})
	// 维护失败只产生本地诊断；最终结果仍保留在 pending 中。
	a.diagnostic = &agent.Output{Raw: raw}
}

// Diagnostics 返回最近一次文件错误；失败次数和下次重试间隔包含在诊断中。
func (a *Adapter) Diagnostics() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastError
}

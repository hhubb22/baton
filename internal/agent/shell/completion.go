package shell

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"baton/internal/agent"
	"baton/internal/identity"
	"baton/internal/privatefile"
)

const completionLimit = 192 * 1024

var errCompletion = errors.New("命令完成记录无效")

type completionRecord struct {
	MessageID      string        `json:"message_id,omitempty"`
	SchemaVersion  int           `json:"schema_version"`
	SessionID      string        `json:"session_id"`
	CompletionKind string        `json:"completion_kind"`
	ProcessStopped bool          `json:"process_stopped"`
	Result         commandOutput `json:"result"`
}

func (a *Adapter) validateIdentity() error {
	if _, err := identity.ParseUUID(a.config.SessionID); err != nil {
		return fmt.Errorf("%w: session_id", errCompletion)
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

func (a *Adapter) loadCompletion() (*completionRecord, error) {
	raw, err := a.readFile(a.historyPath())
	if err != nil {
		return nil, err
	}
	if len(raw) > completionLimit || checkJSON(raw) != nil {
		return nil, fmt.Errorf("%w: JSON 或大小不合法", errCompletion)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 6 || requireFields(fields, "schema_version", "session_id", "message_id", "completion_kind", "process_stopped", "result") != nil {
		return nil, errCompletion
	}
	record := &completionRecord{}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(record); err != nil {
		return nil, fmt.Errorf("%w: %v", errCompletion, err)
	}
	if err := a.validateIdentity(); err != nil {
		return nil, err
	}
	if record.SchemaVersion != 3 || record.MessageID == "" || record.SessionID != a.config.SessionID || !record.ProcessStopped {
		return nil, errCompletion
	}
	var resultFields map[string]json.RawMessage
	if json.Unmarshal(fields["result"], &resultFields) != nil || requireFields(resultFields, "output", "total_bytes", "exit_code", "truncated") != nil {
		return nil, errCompletion
	}
	if encoding, ok := resultFields["encoding"]; ok && bytes.Equal(bytes.TrimSpace(encoding), []byte("null")) {
		return nil, errCompletion
	}
	result := record.Result
	output := []byte(result.Output)
	if result.Encoding == "base64" {
		var err error
		output, err = base64.StdEncoding.DecodeString(result.Output)
		if err != nil {
			return nil, errCompletion
		}
	} else if result.Encoding != "" {
		return nil, errCompletion
	}
	if result.TotalBytes < 0 || result.ExitCode < -1 || int64(len(output)) != min(result.TotalBytes, int64(commandOutputBytes)) || result.Truncated != (result.TotalBytes > commandOutputBytes) {
		return nil, errCompletion
	}
	switch record.CompletionKind {
	case "exited", "stopped":
	default:
		return nil, errCompletion
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

func (a *Adapter) restoreLocked(record *completionRecord) {
	a.restorePending = false
	a.stopped = record.ProcessStopped
	a.completionEventsLocked(record)
}

func (a *Adapter) queueCompletionLocked(result commandOutput, kind string) {
	a.pending = &completionRecord{SchemaVersion: 3, SessionID: a.config.SessionID, MessageID: a.messageID, CompletionKind: kind, ProcessStopped: true, Result: result}
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
			record, err = a.loadCompletion()
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		a.maintaining = false
		if err != nil {
			a.noteFailureLocked(op, err)
			if pending == nil && definitiveHistoryError(err) {
				a.restorePending = false
				a.events = append(a.events, agent.Event{Kind: agent.EventUncertain})
			}
			return
		}
		a.failures, a.lastError, a.retryAt = 0, "", time.Time{}
		if pending != nil {
			a.completionEventsLocked(pending)
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
	a.diagnostic = &agent.Event{Raw: raw}
}

// Diagnostics 返回最近一次文件错误；失败次数和下次重试间隔包含在诊断中。
func (a *Adapter) Diagnostics() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastError
}

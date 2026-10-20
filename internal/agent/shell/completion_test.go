package shell

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"baton/internal/agent"
	"baton/internal/fileaccess"
	"baton/internal/privatefile"
	"baton/internal/privatefiletest"
	"baton/internal/task"
)

func completionFixture(t *testing.T) (*Adapter, completionRecord) {
	t.Helper()
	config := agent.Config{DataDir: t.TempDir(), SessionID: "11111111-1111-4111-8111-111111111111", ExecutionID: "22222222-2222-4222-8222-222222222222"}
	config.SessionDir = filepath.Join(config.DataDir, "sessions", config.SessionID, "native")
	for _, dir := range []string{filepath.Dir(config.SessionDir), config.SessionDir} {
		if err := fileaccess.PrepareDataDir(dir); err != nil {
			t.Fatal(err)
		}
	}
	config.Restore = true
	a := New(config)
	record := completionRecord{SchemaVersion: 1, SessionID: config.SessionID, ExecutionID: config.ExecutionID, InputGeneration: 1, CompletionKind: "exited", ProcessStopped: true, Result: json.RawMessage(formatResult(task.CommandResult{Output: "saved", TotalBytes: 5}, "").Final)}
	return a, record
}

func saveFixture(t *testing.T, a *Adapter, record completionRecord) []byte {
	t.Helper()
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := privatefile.WriteFile(a.historyPath(), raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func waitMaintenance(t *testing.T, a *Adapter) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		busy := a.maintaining
		a.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("文件维护没有结束")
}

func assertReadOnly(t *testing.T, a *Adapter) {
	t.Helper()
	if _, err := a.SubmitInput(context.Background(), `{"description":"exit 0","generation":1}`); err == nil {
		t.Fatal("恢复的执行接受了命令输入")
	}
}

func TestCompletionRecoversWithoutRerunningOrConsumingHistory(t *testing.T) {
	a, root := configured(t)
	marker := filepath.Join(root, "runs")
	command := "printf x >> '" + strings.ReplaceAll(marker, "'", "'\\''") + "'; printf saved"
	if runtime.GOOS == "windows" {
		command = "[IO.File]::AppendAllText('" + strings.ReplaceAll(marker, "'", "''") + "', 'x'); [Console]::Out.Write('saved')"
	}
	want := result(t, a, submit(t, a, command))
	raw, err := privatefile.ReadFile(a.historyPath())
	if err != nil {
		t.Fatal(err)
	}
	var record completionRecord
	if err := json.Unmarshal(raw, &record); err != nil || record.SchemaVersion != 1 || record.SessionID != a.config.SessionID || record.ExecutionID != a.config.ExecutionID || record.InputGeneration != 1 || record.CompletionKind != "exited" || !record.ProcessStopped {
		t.Fatalf("完成记录身份或停止事实错误: %+v %v", record, err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	config := a.config
	config.Restore = true
	for range 2 {
		restored := New(config)
		if err := restored.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		assertReadOnly(t, restored)
		outputs := restored.Drain()
		if len(outputs) != 1 || !outputs[0].Exited || outputs[0].Uncertain || outputs[0].Final != string(record.Result) {
			t.Fatalf("未恢复原结果: %+v", outputs)
		}
		got, err := task.ParseCandidate(outputs[0].Final)
		if err != nil || *got.CommandResult != *want.CommandResult {
			t.Fatalf("恢复改变了命令输出: %+v %v", got, err)
		}
		if len(restored.Drain()) != 0 {
			t.Fatal("Drain 重复交付结果")
		}
		page, err := restored.ReadHistory(context.Background(), "")
		var history []json.RawMessage
		if err != nil || json.Unmarshal(page.Data, &history) != nil || len(history) != 1 || !bytes.Equal(history[0], record.Result) {
			t.Fatalf("历史没有保持候选结果形状: %s %v", page.Data, err)
		}
		if err := restored.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if runs, err := os.ReadFile(marker); err != nil || string(runs) != "x" {
		t.Fatalf("恢复重新执行了命令: %q %v", runs, err)
	}
}

func TestCompletionRejectsCorruptionAndWrongIdentity(t *testing.T) {
	cases := map[string]func([]byte) []byte{
		"session": func(raw []byte) []byte {
			return bytes.ReplaceAll(raw, []byte("11111111-1111-4111-8111-111111111111"), []byte("33333333-3333-4333-8333-333333333333"))
		},
		"execution": func(raw []byte) []byte {
			return bytes.ReplaceAll(raw, []byte("22222222-2222-4222-8222-222222222222"), []byte("33333333-3333-4333-8333-333333333333"))
		},
		"generation": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"input_generation":1`), []byte(`"input_generation":2`), 1)
		},
		"schema": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"schema_version":1`), []byte(`"schema_version":2`), 1)
		},
		"not_stopped": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"process_stopped":true`), []byte(`"process_stopped":false`), 1)
		},
		"kind":                 func(raw []byte) []byte { return bytes.Replace(raw, []byte(`"exited"`), []byte(`"running"`), 1) },
		"false_launch_failure": func(raw []byte) []byte { return bytes.Replace(raw, []byte(`"exited"`), []byte(`"launch_failed"`), 1) },
		"trailing_json":        func(raw []byte) []byte { return append(raw, []byte(` {}`)...) },
		"trailing_garbage":     func(raw []byte) []byte { return append(raw, 'x') },
		"oversized":            func(raw []byte) []byte { return append(raw, bytes.Repeat([]byte(" "), completionLimit)...) },
		"truncated":            func(raw []byte) []byte { return raw[:len(raw)-1] },
		"duplicate_identity": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"session_id":`), []byte(`"session_id":"wrong","session_id":`), 1)
		},
		"case_alias_identity": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"session_id":`), []byte(`"SESSION_ID":"wrong","session_id":`), 1)
		},
		"noncanonical_identity_key": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"session_id":`), []byte(`"SESSION_ID":`), 1)
		},
		"unknown_field":     func(raw []byte) []byte { return append([]byte(`{"extra":0,`), raw[1:]...) },
		"missing_exit_code": func(raw []byte) []byte { return bytes.Replace(raw, []byte(`"exit_code":0,`), nil, 1) },
		"null_exit_code": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"exit_code":0`), []byte(`"exit_code":null`), 1)
		},
		"null_truncated": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"truncated":false`), []byte(`"truncated":null`), 1)
		},
		"case_alias_exit": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"exit_code":0`), []byte(`"EXIT_CODE":1,"exit_code":0`), 1)
		},
		"wrong_byte_count": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"total_bytes":5`), []byte(`"total_bytes":6`), 1)
		},
		"bad_encoding": func(raw []byte) []byte {
			return bytes.Replace(raw, []byte(`"output":"saved"`), []byte(`"encoding":"hex","output":"saved"`), 1)
		},
		"null_result": func(raw []byte) []byte {
			var doc map[string]json.RawMessage
			_ = json.Unmarshal(raw, &doc)
			doc["result"] = json.RawMessage(`null`)
			out, _ := json.Marshal(doc)
			return out
		},
		"invalid_utf8": func(raw []byte) []byte { return bytes.Replace(raw, []byte("saved"), []byte{0xff}, 1) },
	}
	for name, corrupt := range cases {
		t.Run(name, func(t *testing.T) {
			a, record := completionFixture(t)
			raw, _ := json.Marshal(record)
			if err := privatefile.WriteFile(a.historyPath(), corrupt(raw)); err != nil {
				t.Fatal(err)
			}
			if err := a.Start(context.Background()); !errors.Is(err, agent.ErrHistoryMissing) {
				t.Fatalf("接受了损坏的完成记录: %v", err)
			}
			assertReadOnly(t, a)
			for _, out := range a.Drain() {
				if out.Final != "" || out.Exited {
					t.Fatalf("损坏记录暴露了最终输出: %+v", out)
				}
			}
			if _, err := a.ReadHistory(context.Background(), ""); !errors.Is(err, agent.ErrHistoryMissing) {
				t.Fatalf("历史接受损坏记录: %v", err)
			}
		})
	}
}

func TestCompletionPrivateFileChecks(t *testing.T) {
	for _, kind := range []string{"public", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			a, record := completionFixture(t)
			saveFixture(t, a, record)
			switch kind {
			case "public":
				privatefiletest.MakePublic(t, a.historyPath())
			case "directory":
				if err := os.Remove(a.historyPath()); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(a.historyPath(), 0o700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if runtime.GOOS == "windows" {
					t.Skip("符号链接需要 Windows 开发者模式")
				}
				target := filepath.Join(a.config.SessionDir, "other.json")
				if err := os.Rename(a.historyPath(), target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, a.historyPath()); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := a.ReadHistory(context.Background(), ""); err == nil {
				t.Fatal("历史绕过了私有文件检查")
			}
			_ = a.Start(context.Background())
			assertReadOnly(t, a)
			for _, out := range a.Drain() {
				if out.Final != "" || out.Exited {
					t.Fatal("不安全的文件被当作完成证据")
				}
			}
			waitMaintenance(t, a)
		})
	}
}

func TestLegacyCompletionRequiresOriginalSessionDirectoryForRestore(t *testing.T) {
	for _, bound := range []bool{true, false} {
		t.Run(map[bool]string{true: "bound", false: "unbound"}[bound], func(t *testing.T) {
			a, record := completionFixture(t)
			if !bound {
				a.config.SessionDir = t.TempDir()
			}
			if err := privatefile.WriteFile(a.historyPath(), record.Result); err != nil {
				t.Fatal(err)
			}
			page, err := a.ReadHistory(context.Background(), "")
			if err != nil || !bytes.Contains(page.Data, []byte("saved")) {
				t.Fatalf("旧历史不可读: %s %v", page.Data, err)
			}
			err = a.Start(context.Background())
			if bound && err != nil || !bound && !errors.Is(err, agent.ErrHistoryMissing) {
				t.Fatalf("旧完成记录归属校验: %v", err)
			}
			assertReadOnly(t, a)
			if bound {
				out := a.Drain()
				if len(out) != 1 || out[0].Final != string(record.Result) || !out[0].Exited {
					t.Fatalf("未导入旧记录: %+v", out)
				}
			}
		})
	}
}

func advanceRetry(a *Adapter, clock *atomic.Int64) {
	a.mu.Lock()
	clock.Store(a.retryAt.UnixNano())
	a.mu.Unlock()
}

func checkDiagnostic(t *testing.T, outputs []agent.Output, operation string, attempt int) {
	t.Helper()
	if len(outputs) != 1 || outputs[0].Final != "" || outputs[0].Exited || outputs[0].Uncertain {
		t.Fatalf("文件失败提前交付了结果: %+v", outputs)
	}
	var diagnostic struct {
		Type, Operation, Error string
		Attempt                int
		Persistent             bool
	}
	if err := json.Unmarshal(outputs[0].Raw, &diagnostic); err != nil || diagnostic.Type != "shell_completion_error" || diagnostic.Operation != operation || diagnostic.Attempt != attempt || diagnostic.Persistent != (attempt > 1) || diagnostic.Error == "" {
		t.Fatalf("缺少具体失败诊断: %s %v", outputs[0].Raw, err)
	}
}

func TestCompletionSaveFailureRetainsOutputAndDrainRetriesWithoutBlocking(t *testing.T) {
	a, _ := configured(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	a.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var calls atomic.Int32
	entered, release, firstAttempt := make(chan struct{}), make(chan struct{}), make(chan struct{})
	a.writeFile = func(path string, raw []byte) error {
		attempt := calls.Add(1)
		if attempt <= 2 {
			if attempt == 1 {
				close(firstAttempt)
			}
			return &os.PathError{Op: "write", Path: path, Err: syscall.ENOSPC}
		}
		close(entered)
		<-release
		return privatefile.WriteFile(path, raw)
	}
	defer func() { close(release); waitMaintenance(t, a) }()
	command := "printf retained; exit 7"
	if runtime.GOOS == "windows" {
		command = "[Console]::Out.Write('retained'); exit 7"
	}
	initial := submit(t, a, command)
	if initial.Final != "" || initial.Exited {
		t.Fatal("完成记录保存前返回了最终结果")
	}
	select {
	case <-firstAttempt:
	case <-time.After(5 * time.Second):
		t.Fatal("命令退出后没有保存完成记录")
	}
	waitMaintenance(t, a)
	checkDiagnostic(t, a.Drain(), "save", 1)
	if !strings.Contains(a.Diagnostics(), "attempt 1") || !strings.Contains(a.Diagnostics(), "write") {
		t.Fatalf("错误被吞掉: %s", a.Diagnostics())
	}
	if len(a.Drain()) != 0 || calls.Load() != 1 {
		t.Fatal("退避期间重复写入")
	}
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	checkDiagnostic(t, a.Drain(), "save", 2)
	advanceRetry(a, &clock)
	drained := make(chan struct{})
	go func() { a.Drain(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(time.Second):
		t.Fatal("Drain 被文件写入阻塞")
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("没有调度保存重试")
	}
	for range 10 {
		if len(a.Drain()) != 0 {
			t.Fatal("保存成功前泄漏结果")
		}
	}
	if stopped, known := a.StopStatus(); !stopped || known {
		t.Fatalf("文件失败丢失了进程停止事实: %v %v", stopped, known)
	}
	if calls.Load() != 3 {
		t.Fatalf("并发调度了重复写入: %d", calls.Load())
	}
	release <- struct{}{}
	waitMaintenance(t, a)
	outputs := a.Drain()
	if len(outputs) != 1 || !outputs[0].Exited || outputs[0].Uncertain {
		t.Fatalf("没有交付保留的结果: %+v", outputs)
	}
	candidate, err := task.ParseCandidate(outputs[0].Final)
	if err != nil || candidate.Status != task.StatusFailed || candidate.CommandResult.ExitCode != 7 || candidate.CommandResult.Output != "retained" || candidate.CommandResult.TotalBytes != 8 {
		t.Fatalf("保存失败后改变了命令结果: %+v %v", candidate, err)
	}
	if a.Diagnostics() != "" || len(a.Drain()) != 0 {
		t.Fatal("保存成功后仍在失败或重复交付")
	}
	config := a.config
	config.Restore = true
	restored := New(config)
	if err := restored.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := restored.Drain(); len(got) != 1 || got[0].Final != outputs[0].Final {
		t.Fatalf("重试后结果无法恢复: %+v", got)
	}
}

func TestCompletionTransientReadFailureRetriesWithoutSubmitting(t *testing.T) {
	a, record := completionFixture(t)
	saveFixture(t, a, record)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	a.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var calls atomic.Int32
	a.readFile = func(path string) ([]byte, error) {
		switch calls.Add(1) {
		case 1:
			return nil, syscall.EIO
		case 2:
			return nil, &os.PathError{Op: "open", Path: path, Err: os.ErrPermission}
		default:
			return readCompletionFile(path)
		}
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertReadOnly(t, a)
	if stopped, known, err := a.Abort(); err != nil || stopped || known {
		t.Fatalf("读取暂时失败被当成停止证据: %v %v %v", stopped, known, err)
	}
	checkDiagnostic(t, a.Drain(), "read", 1)
	if calls.Load() != 1 {
		t.Fatal("读取重试没有退避")
	}
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	checkDiagnostic(t, a.Drain(), "read", 2)
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	outputs := a.Drain()
	if len(outputs) != 1 || outputs[0].Final != string(record.Result) || !outputs[0].Exited || outputs[0].Uncertain {
		t.Fatalf("暂时失败后丢失完成记录: %+v", outputs)
	}
	assertReadOnly(t, a)
}

func TestStoppedCompletionRecoversOutputAsUncertain(t *testing.T) {
	a, record := completionFixture(t)
	record.CompletionKind = "stopped"
	// 取消与自然退出竞争时，shell 可能已经返回退出码 0。
	saveFixture(t, a, record)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertReadOnly(t, a)
	if stopped, known, err := a.Abort(); err != nil || !stopped || known {
		t.Fatalf("恢复停止事实错误: %v %v %v", stopped, known, err)
	}
	out := a.Drain()
	if len(out) != 1 || !out[0].Exited || !out[0].Uncertain || out[0].Final != string(record.Result) {
		t.Fatalf("取消输出被作为正常完成交付: %+v", out)
	}
	if len(a.Drain()) != 0 {
		t.Fatal("停止输出重复交付")
	}
}

func assertStoppedRecovery(t *testing.T, a *Adapter) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var output agent.Output
	for time.Now().Before(deadline) {
		for _, out := range a.Drain() {
			if out.Exited {
				output = out
			}
		}
		if output.Exited {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !output.Exited || !output.Uncertain {
		t.Fatalf("取消没有交付带停止语义的输出: %+v", output)
	}
	candidate, err := task.ParseCandidate(output.Final)
	if err != nil || candidate.CommandResult == nil || candidate.CommandResult.Output != "before-stop" {
		t.Fatalf("取消丢失了已捕获输出: %+v %v", candidate, err)
	}
	config := a.config
	config.Restore = true
	restored := New(config)
	if err := restored.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertReadOnly(t, restored)
	out := restored.Drain()
	if len(out) != 1 || !out[0].Exited || !out[0].Uncertain || out[0].Final != output.Final {
		t.Fatalf("取消后恢复改变了停止事实或输出: %+v", out)
	}
}

func TestLaunchFailureCompletionIsRecoverable(t *testing.T) {
	a, _ := completionFixture(t)
	a.config.Restore = false
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := result(t, a, submit(t, a, "exit 0"))
	if got.Status != task.StatusFailed || got.CommandResult.ExitCode != -1 {
		t.Fatalf("缺少启动失败结果: %+v", got)
	}
	record, err := a.loadCompletion(false)
	if err != nil || record.CompletionKind != "launch_failed" || !record.ProcessStopped {
		t.Fatalf("缺少启动失败证据: %+v %v", record, err)
	}
	config := a.config
	config.Restore = true
	restored := New(config)
	if err := restored.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertReadOnly(t, restored)
	out := restored.Drain()
	if len(out) != 1 || out[0].Final != string(record.Result) || !out[0].Exited || out[0].Uncertain {
		t.Fatalf("启动失败没有恢复: %+v", out)
	}
}

func TestReadRetryDetectsDefinitiveCorruption(t *testing.T) {
	a, _ := completionFixture(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	a.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var calls atomic.Int32
	a.readFile = func(string) ([]byte, error) {
		if calls.Add(1) == 1 {
			return nil, syscall.EIO
		}
		return []byte(`{"schema_version":1}`), nil
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	checkDiagnostic(t, a.Drain(), "read", 1)
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	outputs := a.Drain()
	if len(outputs) != 2 || !outputs[0].Uncertain || outputs[0].Exited || outputs[0].Final != "" {
		t.Fatalf("确定损坏后没有保留待核实: %+v", outputs)
	}
	assertReadOnly(t, a)
	advanceRetry(a, &clock)
	if len(a.Drain()) != 0 || calls.Load() != 2 {
		t.Fatal("确定损坏后仍反复读取或重新交付")
	}
}

func TestAbortBeforeInputPreventsLaunch(t *testing.T) {
	a, _ := configured(t)
	if stopped, known, err := a.Abort(); err != nil || !stopped || !known {
		t.Fatalf("输入前停止失败: %v %v %v", stopped, known, err)
	}
	if _, err := a.SubmitInput(context.Background(), `{"description":"exit 0","generation":1}`); err == nil {
		t.Fatal("停止后仍接受命令")
	}
}

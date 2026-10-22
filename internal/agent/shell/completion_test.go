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
)

func completionFixture(t *testing.T) (*Adapter, completionRecord) {
	t.Helper()
	config := agent.Config{DataDir: t.TempDir(), SessionID: "11111111-1111-4111-8111-111111111111", Restore: true}
	config.SessionDir = filepath.Join(config.DataDir, "sessions", config.SessionID, "native")
	for _, dir := range []string{filepath.Dir(config.SessionDir), config.SessionDir} {
		if err := fileaccess.PrepareDataDir(dir); err != nil {
			t.Fatal(err)
		}
	}
	return New(config), completionRecord{SchemaVersion: 3, SessionID: config.SessionID, MessageID: "message", CompletionKind: "exited", ProcessStopped: true, Result: commandOutput{Output: "saved", TotalBytes: 5}}
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
	t.Fatal("file maintenance did not finish")
}
func assertReadOnly(t *testing.T, a *Adapter) {
	t.Helper()
	if err := a.Send(context.Background(), "again", "exit 0", ""); err == nil {
		t.Fatal("restored Thread accepted another command")
	}
}
func assertCompletionEvents(t *testing.T, events []agent.Event, want commandOutput, reason string) {
	t.Helper()
	if len(events) != 3 || events[0].Kind != agent.EventReply || events[1].Kind != agent.EventTurnEnded || events[1].Reason != reason || events[2].Kind != agent.EventExited {
		t.Fatal(events)
	}
	reply := events[0]
	var metadata struct {
		ExitCode int    `json:"exit_code"`
		Encoding string `json:"encoding"`
	}
	if err := json.Unmarshal(reply.Metadata, &metadata); err != nil || metadata.ExitCode != want.ExitCode || metadata.Encoding != want.Encoding || reply.Content != want.Output || reply.OriginalBytes != want.TotalBytes || reply.Truncated != want.Truncated {
		t.Fatal(reply, metadata, err)
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
	record, err := a.loadCompletion()
	if err != nil {
		t.Fatal(err)
	}
	if record.SchemaVersion != 3 || record.SessionID != a.config.SessionID || record.MessageID != "message" || !record.ProcessStopped {
		t.Fatal(record)
	}
	config := a.config
	config.Restore = true
	for range 2 {
		b := New(config)
		if err := b.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		assertReadOnly(t, b)
		assertCompletionEvents(t, b.Drain(), want, agent.EndCompleted)
		if len(b.Drain()) != 0 {
			t.Fatal("repeated completion")
		}
		page, err := b.ReadHistory(context.Background(), "")
		var history []commandOutput
		if err != nil || json.Unmarshal(page.Data, &history) != nil || len(history) != 1 || history[0] != want {
			t.Fatal(string(page.Data), err)
		}
		if err := b.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "x" {
		t.Fatal(string(raw), err)
	}
}
func TestCompletionRejectsCorruptionAndWrongIdentity(t *testing.T) {
	replace := func(from, to string) func([]byte) []byte {
		return func(raw []byte) []byte { return bytes.Replace(raw, []byte(from), []byte(to), 1) }
	}
	cases := map[string]func([]byte) []byte{
		"session":            replace("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"),
		"empty_message":      replace(`"message_id":"message"`, `"message_id":""`),
		"schema":             replace(`"schema_version":3`, `"schema_version":1`),
		"not_stopped":        replace(`"process_stopped":true`, `"process_stopped":false`),
		"kind":               replace(`"exited"`, `"running"`),
		"trailing_json":      func(raw []byte) []byte { return append(raw, []byte(` {}`)...) },
		"trailing_garbage":   func(raw []byte) []byte { return append(raw, 'x') },
		"oversized":          func(raw []byte) []byte { return append(raw, bytes.Repeat([]byte(" "), completionLimit)...) },
		"truncated":          func(raw []byte) []byte { return raw[:len(raw)-1] },
		"duplicate_identity": replace(`"session_id":`, `"session_id":"wrong","session_id":`),
		"case_alias":         replace(`"session_id":`, `"SESSION_ID":"wrong","session_id":`),
		"noncanonical_key":   replace(`"session_id":`, `"SESSION_ID":`),
		"unknown_field":      func(raw []byte) []byte { return append([]byte(`{"extra":0,`), raw[1:]...) },
		"missing_exit_code":  replace(`"exit_code":0,`, ``),
		"null_exit_code":     replace(`"exit_code":0`, `"exit_code":null`),
		"null_truncated":     replace(`"truncated":false`, `"truncated":null`),
		"null_encoding":      replace(`"output":"saved"`, `"encoding":null,"output":"saved"`),
		"case_alias_exit":    replace(`"exit_code":0`, `"EXIT_CODE":1,"exit_code":0`),
		"wrong_byte_count":   replace(`"total_bytes":5`, `"total_bytes":6`),
		"bad_encoding":       replace(`"output":"saved"`, `"encoding":"hex","output":"saved"`),
		"invalid_base64":     replace(`"output":"saved"`, `"encoding":"base64","output":"?"`),
		"negative_exit":      replace(`"exit_code":0`, `"exit_code":-2`),
		"invalid_utf8":       func(raw []byte) []byte { return bytes.Replace(raw, []byte("saved"), []byte{0xff}, 1) },
		"null_result": func(raw []byte) []byte {
			var doc map[string]json.RawMessage
			_ = json.Unmarshal(raw, &doc)
			doc["result"] = json.RawMessage(`null`)
			out, _ := json.Marshal(doc)
			return out
		},
	}
	for name, corrupt := range cases {
		t.Run(name, func(t *testing.T) {
			a, record := completionFixture(t)
			raw, _ := json.Marshal(record)
			bad := corrupt(raw)
			if bytes.Equal(raw, bad) {
				t.Fatal("corruption did not alter fixture")
			}
			if err := privatefile.WriteFile(a.historyPath(), bad); err != nil {
				t.Fatal(err)
			}
			if err := a.Start(context.Background()); !errors.Is(err, agent.ErrHistoryMissing) {
				t.Fatal("corrupt completion accepted", err)
			}
			assertReadOnly(t, a)
			for _, e := range a.Drain() {
				if e.Kind == agent.EventReply || e.Kind == agent.EventTurnEnded {
					t.Fatal("corrupt output published", e)
				}
			}
			if _, err := a.ReadHistory(context.Background(), ""); !errors.Is(err, agent.ErrHistoryMissing) {
				t.Fatal(err)
			}
		})
	}
}
func TestCompletionPrivateFileChecks(t *testing.T) {
	for _, kind := range []string{"public", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			a, r := completionFixture(t)
			saveFixture(t, a, r)
			switch kind {
			case "public":
				privatefiletest.MakePublic(t, a.historyPath())
			case "directory":
				if err := os.Remove(a.historyPath()); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(a.historyPath(), 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if runtime.GOOS == "windows" {
					t.Skip("symlinks require developer mode")
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
				t.Fatal("unsafe history accepted")
			}
			_ = a.Start(context.Background())
			assertReadOnly(t, a)
			for _, e := range a.Drain() {
				if e.Kind == agent.EventReply || e.Kind == agent.EventTurnEnded {
					t.Fatal(e)
				}
			}
			waitMaintenance(t, a)
		})
	}
}
func advanceRetry(a *Adapter, clock *atomic.Int64) {
	a.mu.Lock()
	clock.Store(a.retryAt.UnixNano())
	a.mu.Unlock()
}
func checkDiagnostic(t *testing.T, events []agent.Event, operation string, attempt int) {
	t.Helper()
	var found bool
	for _, e := range events {
		if e.Kind == agent.EventTurnStarted {
			continue
		}
		if e.Kind != "" {
			t.Fatal("completion published during file failure", events)
		}
		var d struct {
			Type, Operation, Error string
			Attempt                int
			Persistent             bool
		}
		if err := json.Unmarshal(e.Raw, &d); err != nil || d.Type != "shell_completion_error" || d.Operation != operation || d.Attempt != attempt || d.Persistent != (attempt > 1) || d.Error == "" {
			t.Fatal(string(e.Raw), err)
		}
		found = true
	}
	if !found {
		t.Fatal("missing file failure diagnostic", events)
	}
}
func TestCompletionSaveFailureRetainsOutputAndDrainRetriesWithoutBlocking(t *testing.T) {
	a, _ := configured(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	a.now = func() time.Time { return time.Unix(0, clock.Load()) }
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	a.writeFile = func(path string, raw []byte) error {
		attempt := calls.Add(1)
		if attempt <= 2 {
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
	submit(t, a, command)
	<-a.done
	waitMaintenance(t, a)
	checkDiagnostic(t, a.Drain(), "save", 1)
	if !strings.Contains(a.Diagnostics(), "attempt 1") {
		t.Fatal(a.Diagnostics())
	}
	if len(a.Drain()) != 0 || calls.Load() != 1 {
		t.Fatal("retry did not back off")
	}
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	checkDiagnostic(t, a.Drain(), "save", 2)
	advanceRetry(a, &clock)
	done := make(chan struct{})
	go func() { a.Drain(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Drain blocked on file write")
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("retry not scheduled")
	}
	for range 10 {
		if len(a.Drain()) != 0 {
			t.Fatal("unpersisted output leaked")
		}
	}
	if calls.Load() != 3 {
		t.Fatal(calls.Load())
	}
	release <- struct{}{}
	waitMaintenance(t, a)
	want := commandOutput{Output: "retained", TotalBytes: 8, ExitCode: 7}
	assertCompletionEvents(t, a.Drain(), want, agent.EndCompleted)
	if a.Diagnostics() != "" || len(a.Drain()) != 0 {
		t.Fatal("completion repeated or error retained")
	}
	config := a.config
	config.Restore = true
	b := New(config)
	if err := b.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletionEvents(t, b.Drain(), want, agent.EndCompleted)
}
func TestCompletionTransientReadFailureRetriesWithoutSubmitting(t *testing.T) {
	a, r := completionFixture(t)
	saveFixture(t, a, r)
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
		t.Fatal(stopped, known, err)
	}
	checkDiagnostic(t, a.Drain(), "read", 1)
	if calls.Load() != 1 {
		t.Fatal("read retry did not back off")
	}
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	checkDiagnostic(t, a.Drain(), "read", 2)
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	assertCompletionEvents(t, a.Drain(), r.Result, agent.EndCompleted)
	assertReadOnly(t, a)
}
func TestStoppedCompletionRecoversOutput(t *testing.T) {
	a, r := completionFixture(t)
	r.CompletionKind = "stopped"
	saveFixture(t, a, r)
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertReadOnly(t, a)
	if stopped, known, err := a.Abort(); err != nil || !stopped || known {
		t.Fatal(stopped, known, err)
	}
	assertCompletionEvents(t, a.Drain(), r.Result, agent.EndStopped)
	if len(a.Drain()) != 0 {
		t.Fatal("repeated completion")
	}
}
func assertStoppedRecovery(t *testing.T, a *Adapter) {
	t.Helper()
	events := threadEvents(t, a)
	var reply agent.Event
	ended := false
	for _, e := range events {
		if e.Kind == agent.EventReply {
			reply = e
		}
		if e.Kind == agent.EventTurnEnded {
			ended = e.Reason == agent.EndStopped
		}
	}
	if !ended || reply.Content != "before-stop" {
		t.Fatal(events)
	}
	config := a.config
	config.Restore = true
	b := New(config)
	if err := b.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertReadOnly(t, b)
	assertCompletionEvents(t, b.Drain(), commandOutput{Output: reply.Content, TotalBytes: reply.OriginalBytes, Truncated: reply.Truncated, ExitCode: -1}, agent.EndStopped)
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
		return []byte(`{"schema_version":2}`), nil
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	checkDiagnostic(t, a.Drain(), "read", 1)
	advanceRetry(a, &clock)
	a.Drain()
	waitMaintenance(t, a)
	events := a.Drain()
	if len(events) != 2 || events[0].Kind != agent.EventUncertain {
		t.Fatal(events)
	}
	assertReadOnly(t, a)
	advanceRetry(a, &clock)
	if len(a.Drain()) != 0 || calls.Load() != 2 {
		t.Fatal("definitive corruption retried")
	}
}
func TestAbortBeforeInputPreventsLaunch(t *testing.T) {
	a, _ := configured(t)
	if stopped, known, err := a.Abort(); err != nil || !stopped || !known {
		t.Fatal(stopped, known, err)
	}
	assertReadOnly(t, a)
}

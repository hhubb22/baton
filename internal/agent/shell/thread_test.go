package shell

import (
	"context"
	"encoding/base64"
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
	"baton/internal/privatefile"
	"baton/internal/projectexec"
	"baton/internal/protocol"
)

func threadEvents(t *testing.T, a *Adapter) []agent.Event {
	t.Helper()
	var events []agent.Event
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range a.DrainEvents() {
			events = append(events, e)
			if e.Kind == agent.EventExited {
				return events
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("shell Thread did not exit", events)
	return nil
}

func TestThreadCommandAndRestore(t *testing.T) {
	a, root := configured(t)
	// Thread execution has no legacy task execution ID.
	a.config.ExecutionID = ""
	if a.Capabilities() != (agent.Capabilities{}) {
		t.Fatal(a.Capabilities())
	}
	if err := a.Steer(context.Background(), "steer", "text"); !errors.Is(err, agent.ErrUnsupported) {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "runs")
	command := "printf x >> '" + strings.ReplaceAll(marker, "'", "'\\''") + "'; printf stdout; printf stderr >&2; exit 7"
	if runtime.GOOS == "windows" {
		command = "[IO.File]::AppendAllText('" + strings.ReplaceAll(marker, "'", "''") + "', 'x'); [Console]::Out.Write('stdout'); [Console]::Error.Write('stderr'); exit 7"
	}
	if err := a.Send(context.Background(), "message-1", command, ""); err != nil {
		t.Fatal(err)
	}
	events := threadEvents(t, a)
	if len(events) != 4 || events[0].Kind != agent.EventTurnStarted || events[1].Kind != agent.EventReply || events[2].Kind != agent.EventTurnEnded || events[2].Reason != agent.EndCompleted || events[3].Kind != agent.EventExited {
		t.Fatal(events)
	}
	reply := events[1]
	var metadata struct {
		ExitCode int    `json:"exit_code"`
		Encoding string `json:"encoding"`
	}
	if err := json.Unmarshal(reply.Metadata, &metadata); err != nil || metadata.ExitCode != 7 || metadata.Encoding != "" || reply.OriginalBytes != 12 || reply.Truncated || !strings.Contains(reply.Content, "stdout") || !strings.Contains(reply.Content, "stderr") {
		t.Fatal(reply, metadata, err)
	}
	for _, e := range events {
		if e.ClientMessageID != "message-1" || e.NativeSessionID != a.config.SessionID {
			t.Fatal(e)
		}
	}
	if err := a.Send(context.Background(), "message-2", "exit 0", ""); err == nil {
		t.Fatal("second turn accepted")
	}
	if sent, err := a.Sent("message-1"); err != nil || !sent {
		t.Fatal(sent, err)
	}
	if sent, err := a.Sent("other"); err != nil || sent {
		t.Fatal(sent, err)
	}
	config := a.config
	config.Restore = true
	b := New(config)
	defer b.Close()
	if err := b.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	restored := b.DrainEvents()
	if len(restored) != 3 || restored[0].Content != reply.Content || restored[1].Reason != agent.EndCompleted {
		t.Fatal(restored)
	}
	if len(b.DrainEvents()) != 0 {
		t.Fatal("duplicate recovery events")
	}
	if sent, err := b.Sent("message-1"); err != nil || !sent {
		t.Fatal(sent, err)
	}
	if err := b.Send(context.Background(), "message-1", command, ""); err == nil {
		t.Fatal("restored command reran")
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "x" {
		t.Fatal(string(raw), err)
	}
	raw, err := readCompletionFile(a.historyPath())
	if err != nil {
		t.Fatal(err)
	}
	var record completionRecord
	if err := json.Unmarshal(raw, &record); err != nil || record.SchemaVersion != 2 || record.MessageID != "message-1" || record.SessionID != a.config.SessionID {
		t.Fatal(record, err)
	}
	record.SessionID = "33333333-3333-4333-8333-333333333333"
	raw, _ = json.Marshal(record)
	if err := privatefile.WriteFile(a.historyPath(), raw); err != nil {
		t.Fatal(err)
	}
	if sent, err := b.Sent("message-1"); err == nil || sent {
		t.Fatal("mismatched identity accepted", sent, err)
	}
}

func TestThreadCompletionWaitsForDurableRecord(t *testing.T) {
	a, _ := configured(t)
	var fail atomic.Bool
	fail.Store(true)
	a.writeFile = func(path string, raw []byte) error {
		if fail.Load() {
			return syscall.ENOSPC
		}
		return privatefile.WriteFile(path, raw)
	}
	if err := a.Send(context.Background(), "durable", "echo saved", ""); err != nil {
		t.Fatal(err)
	}
	<-a.done
	waitMaintenance(t, a)
	events := a.DrainEvents()
	if len(events) != 1 || events[0].Kind != agent.EventTurnStarted {
		t.Fatal("unpersisted output published", events)
	}
	if sent, err := a.Sent("durable"); sent || err == nil {
		t.Fatal("missing completion proved send", sent, err)
	}
	fail.Store(false)
	a.mu.Lock()
	a.retryAt = time.Time{}
	a.mu.Unlock()
	events = threadEvents(t, a)
	if len(events) != 3 || events[0].Kind != agent.EventReply || events[1].Kind != agent.EventTurnEnded {
		t.Fatal(events)
	}
}

func TestThreadRejectsDisabledExec(t *testing.T) {
	a, _ := configured(t)
	if err := projectexec.WriteProjectExec(a.config.DataDir, protocol.RuntimeExec{Enabled: false, Shell: "missing"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Send(context.Background(), "disabled", "echo forbidden", ""); err == nil {
		t.Fatal("disabled command accepted")
	}
	if len(a.DrainEvents()) != 0 || a.process != nil {
		t.Fatal("disabled command started")
	}
}

func TestThreadBusyAbortAndRecovery(t *testing.T) {
	a, _ := configured(t)
	command := "printf before-stop; sleep 60"
	if runtime.GOOS == "windows" {
		command = "[Console]::Out.Write('before-stop'); Start-Sleep -Seconds 60"
	}
	if err := a.Send(context.Background(), "stop", command, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.Send(context.Background(), "busy", "exit 0", ""); !errors.Is(err, agent.ErrBusy) {
		t.Fatal(err)
	}
	if stopped, known, err := a.Abort(); err != nil || !stopped || known {
		t.Fatal(stopped, known, err)
	}
	events := threadEvents(t, a)
	if len(events) != 4 || events[2].Reason != agent.EndStopped {
		t.Fatal(events)
	}
	config := a.config
	config.Restore = true
	b := New(config)
	defer b.Close()
	if err := b.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if events := b.DrainEvents(); len(events) != 3 || events[1].Reason != agent.EndStopped {
		t.Fatal(events)
	}
}

func TestThreadBinaryAndTruncatedOutputEvents(t *testing.T) {
	for _, binary := range []bool{false, true} {
		t.Run(map[bool]string{false: "text", true: "binary"}[binary], func(t *testing.T) {
			a, _ := configured(t)
			var output boundedOutput
			raw := []byte(strings.Repeat("H", 16*1024) + strings.Repeat("M", 40*1024) + strings.Repeat("T", 16*1024))
			if binary {
				raw[0] = 0xff
				raw[len(raw)-1] = 0
			}
			_, _ = output.Write(raw)
			a.mu.Lock()
			a.threadMode, a.messageID = true, "output"
			a.queueCompletionLocked(formatResult(output.result(0), ""), "exited")
			a.mu.Unlock()
			events := threadEvents(t, a)
			reply := events[0]
			if len(events) != 3 || reply.Kind != agent.EventReply || !reply.Truncated || reply.OriginalBytes != int64(len(raw)) {
				t.Fatal(events)
			}
			content := []byte(reply.Content)
			if binary {
				var err error
				content, err = base64.StdEncoding.DecodeString(reply.Content)
				if err != nil || !strings.Contains(string(reply.Metadata), `"encoding":"base64"`) {
					t.Fatal(reply, err)
				}
			}
			want := append(append([]byte{}, raw[:16*1024]...), raw[len(raw)-16*1024:]...)
			if string(content) != string(want) {
				t.Fatal("head/tail output changed")
			}
		})
	}
}

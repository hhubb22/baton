package codex

import (
	"baton/internal/agent/codex/codexreplaytest"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestTranscriptReplayRecordedEarlyInterrupt(t *testing.T) {
	binary := codexreplaytest.Build(t, "../../../tools/agent-replay")
	tape := codexreplaytest.RecordedEarlyInterrupt(t, "testdata/replay")
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	f := codexreplaytest.New(t, binary, work, home, tape, "event:turn/started", "event:turn/completed", "process:done")
	a := New(Config{Directory: work, Home: home, SessionID: "session", ExecutionID: "execution", StatePath: filepath.Join(home, "state.json"), Model: tape.Header.Model, Binary: f.Binary})
	defer a.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := a.Start(ctx); err != nil {
		f.Check(t)
		t.Fatal(err)
	}
	if _, err := a.SubmitInput(ctx, `{"description":"early interrupt","generation":1}`); err != nil {
		f.Check(t)
		t.Fatal(err)
	}
	if stopped, known, err := a.Abort(); stopped || known || err != nil {
		t.Fatalf("早到中止: %v %v %v", stopped, known, err)
	}
	f.Wait(t, "event:turn/started")
	f.Release(t, "event:turn/started")
	f.Wait(t, "event:turn/completed")
	if stopped, known := a.StopStatus(); stopped || known {
		t.Fatal("补发 ACK 成为停止证据")
	}
	f.Release(t, "event:turn/completed")
	for {
		if stopped, known := a.StopStatus(); stopped {
			if known {
				t.Fatal("副作用被推定已知")
			}
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if page, err := a.ReadHistory(ctx, ""); err != nil || !json.Valid(page.Data) {
		f.Check(t)
		t.Fatalf("中止后的原生历史: %v", err)
	}
	f.Wait(t, "process:done")
	for _, out := range a.Drain() {
		if out.Final != "" {
			t.Fatal("中止回合交付了最终结果")
		}
	}
	f.Check(t)
}

func TestTranscriptReplayEarlyInterrupt(t *testing.T) {
	binary := codexreplaytest.Build(t, "../../../tools/agent-replay")
	for _, variant := range []string{"after_error", "started_before_error", "retry_error", "other_error", "completed_before_started"} {
		t.Run(variant, func(t *testing.T) {
			tape := codexreplaytest.EarlyInterrupt(t, "testdata/replay", variant)
			work, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			home := t.TempDir()
			f := codexreplaytest.New(t, binary, work, home, tape, "event:other_completed", "event:turn/completed", "process:done")
			a := New(Config{Directory: work, Home: home, SessionID: "session", ExecutionID: "execution", StatePath: filepath.Join(home, "state.json"), Model: tape.Header.Model, Binary: f.Binary})
			defer a.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := a.Start(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := a.SubmitInput(ctx, `{"description":"early interrupt","generation":1}`); err != nil {
				t.Fatal(err)
			}
			stopped, known, err := a.Abort()
			if stopped || known || (err != nil) != (variant == "other_error") {
				t.Fatalf("早到中止: %v %v %v", stopped, known, err)
			}
			f.Wait(t, "event:other_completed")
			if stopped, known := a.StopStatus(); stopped || known {
				t.Fatal("ACK/其他回合成为停止证据")
			}
			// 重复 Abort 不能再发送第一次请求，也不能消耗补发额度。
			if stopped, known, err := a.Abort(); stopped || known || (err != nil) != (variant == "other_error") {
				t.Fatalf("重复中止: %v %v %v", stopped, known, err)
			}
			f.Release(t, "event:other_completed")
			f.Wait(t, "event:turn/completed")
			if stopped, known := a.StopStatus(); stopped || known {
				t.Fatal("完成事件前确认停止")
			}
			f.Release(t, "event:turn/completed")
			for {
				if stopped, known := a.StopStatus(); stopped {
					if known {
						t.Fatal("推定副作用已知")
					}
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(time.Millisecond):
				}
			}
			if s := a.Snapshot(); s.ThreadID != "thread-1" || s.TurnID != "turn-1" {
				t.Fatalf("回合身份变化: %+v", s)
			}
			// 历史请求排在重复开始通知之后；多发中止帧会与该请求失配。
			if _, err := a.ReadHistory(ctx, ""); err != nil {
				f.Check(t)
				t.Fatal(err)
			}
			f.Wait(t, "process:done")
			f.Check(t)
		})
	}
}

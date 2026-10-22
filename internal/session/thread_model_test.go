package session

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"baton/internal/agent"
)

func threadModel(t *testing.T, w *ThreadWorker) string {
	t.Helper()
	var model string
	threadMust(t, w.db.QueryRow(`SELECT model FROM thread_meta`).Scan(&model))
	return model
}

func TestThreadModelsChangeAtTurnBoundaryAndPersist(t *testing.T) {
	a := &threadFake{resume: true, steer: true, switchModel: true}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.Model = "initial" }, a)
	ctx := context.Background()
	if a.configs[0].Model != "initial" || threadModel(t, w) != "initial" {
		t.Fatalf("startup model: configs=%+v current=%s", a.configs, threadModel(t, w))
	}
	threadMessage(t, w, "first", "queue")
	threadMust(t, w.EnqueueThreadMessage(ctx, "second", "next", "queue", "replacement"))
	threadMessage(t, w, "third", "queue")
	threadMessage(t, w, "steer", "steer")
	if threadModel(t, w) != "initial" || len(a.sends) != 1 || len(a.steers) != 1 {
		t.Fatalf("queued model changed active turn: sends=%v steers=%v current=%s", a.sends, a.steers, threadModel(t, w))
	}
	threadMust(t, w.EnqueueThreadMessage(ctx, "second", "next", "queue", "replacement"))
	if err := w.EnqueueThreadMessage(ctx, "second", "next", "queue", "other"); err == nil {
		t.Fatal("accepted different model under the same message ID")
	}
	for range 3 {
		a.add(agent.Event{Kind: agent.EventTurnEnded, Reason: agent.EndCompleted})
		threadMust(t, w.Poll(ctx))
	}
	want := []string{"initial", "replacement", "replacement"}
	if !reflect.DeepEqual(a.models, want) {
		t.Fatalf("models=%v want=%v", a.models, want)
	}
	var started, ended []string
	for _, report := range threadReports(t, w) {
		switch report.Kind {
		case "turn.started":
			started = append(started, report.Model)
		case "turn.ended":
			ended = append(ended, report.Model)
		}
	}
	if !reflect.DeepEqual(started, want) || !reflect.DeepEqual(ended, want) {
		t.Fatalf("started=%v ended=%v", started, ended)
	}
	if n := threadCount(t, w, `SELECT COUNT(*) FROM thread_turns WHERE model='replacement'`); n != 2 {
		t.Fatalf("saved replacement turns=%d", n)
	}
	if n := threadCount(t, w, `SELECT COUNT(*) FROM thread_messages WHERE model<>''`); n != 1 {
		t.Fatalf("optional message models were filled: %d", n)
	}
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	b := &threadFake{resume: true, switchModel: true}
	restored, err := OpenThreadWorker(ctx, data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	if b.configs[0].Model != "replacement" || !b.configs[0].Restore {
		t.Fatalf("restored config=%+v", b.configs[0])
	}
	threadMessage(t, restored, "after-restart", "queue")
	if !reflect.DeepEqual(b.models, []string{"replacement"}) {
		t.Fatalf("restored send models=%v", b.models)
	}
}

func TestThreadRejectsUnsupportedModelAndSteerModelBeforeSaving(t *testing.T) {
	for _, mode := range []string{"queue", "steer"} {
		for _, active := range []bool{false, true} {
			t.Run(mode+map[bool]string{false: "/idle", true: "/active"}[active], func(t *testing.T) {
				a := &threadFake{resume: true, steer: true, switchModel: mode == "steer"}
				w := newThreadTestWorker(t, nil, a)
				if active {
					threadMessage(t, w, "first", "queue")
				}
				err := w.EnqueueThreadMessage(context.Background(), "rejected", "body", mode, "other")
				if err == nil || (mode == "queue" && !errors.Is(err, agent.ErrUnsupported)) {
					t.Fatalf("model request error=%v", err)
				}
				if n := threadCount(t, w, `SELECT COUNT(*) FROM thread_messages WHERE client_message_id='rejected'`); n != 0 {
					t.Fatal("rejected model request was saved")
				}
				if len(a.steers) != 0 || threadModel(t, w) != "" {
					t.Fatal("rejected request changed adapter or model")
				}
			})
		}
	}
}

func TestThreadModelSwitchFailureReportsCauseAndContinuesQueue(t *testing.T) {
	for _, queued := range []bool{false, true} {
		t.Run(map[bool]string{false: "idle", true: "queued"}[queued], func(t *testing.T) {
			a := &threadFake{resume: true, switchModel: true, switchErr: errors.New("model unavailable")}
			w := newThreadTestWorker(t, func(o *ThreadOptions) { o.Model = "initial" }, a)
			ctx := context.Background()
			if queued {
				threadMessage(t, w, "first", "queue")
			}
			threadMust(t, w.EnqueueThreadMessage(ctx, "change", "must not send", "queue", "unavailable"))
			if queued {
				threadMessage(t, w, "next", "queue")
				a.add(agent.Event{Kind: agent.EventTurnEnded})
				threadMust(t, w.Poll(ctx))
			}
			if w.adapter != a || threadModel(t, w) != "initial" {
				t.Fatal("failed switch closed the adapter or changed the model")
			}
			if !queued {
				if threadState(t, w) != "idle" {
					t.Fatal("failed switch did not leave Thread idle")
				}
				threadMessage(t, w, "next", "queue")
			}
			for range 2 {
				threadMust(t, w.Poll(ctx))
				threadMust(t, w.EnqueueThreadMessage(ctx, "change", "must not send", "queue", "unavailable"))
			}
			want := []string{"next"}
			if queued {
				want = []string{"first", "next"}
			}
			if !reflect.DeepEqual(a.sends, want) || threadState(t, w) != "running" {
				t.Fatalf("queue did not continue: sends=%v state=%s", a.sends, threadState(t, w))
			}
			if n := threadCount(t, w, `SELECT COUNT(*) FROM thread_turns`); n != len(want) {
				t.Fatalf("failed switch created a turn: %d", n)
			}
			if n := threadCount(t, w, `SELECT COUNT(*) FROM thread_messages WHERE client_message_id='change' AND status='withdrawn' AND turn_seq=0 AND status_reason LIKE '%model unavailable%'`); n != 1 {
				t.Fatalf("failed message missing status or reason: %d", n)
			}
			withdrawn := 0
			for _, report := range threadReports(t, w) {
				if report.Kind == "thread.stopped" {
					t.Fatal("failed switch stopped the Thread")
				}
				if report.Kind == "message.withdrawn" && report.ClientMessageID == "change" && strings.Contains(report.Reason, "model unavailable") {
					withdrawn++
				}
			}
			if withdrawn != 1 {
				t.Fatalf("withdrawal reports=%d", withdrawn)
			}
		})
	}
}

func TestThreadModelFailureReasonFitsReportProtocol(t *testing.T) {
	for name, reason := range map[string]string{
		"long":         strings.Repeat("x", 5000),
		"multibyte":    strings.Repeat("模型", 1000),
		"invalid-text": "unavailable\x00bad\xff",
	} {
		t.Run(name, func(t *testing.T) {
			a := &threadFake{resume: true, switchModel: true, switchErr: errors.New(reason)}
			w := newThreadTestWorker(t, func(o *ThreadOptions) { o.Model = "initial" }, a)
			threadMust(t, w.EnqueueThreadMessage(context.Background(), "change", "do not send", "queue", "unavailable"))
			var saved string
			threadMust(t, w.db.QueryRow(`SELECT status_reason FROM thread_messages WHERE client_message_id='change'`).Scan(&saved))
			if len(saved) == 0 || len(saved) > 4096 || !utf8.ValidString(saved) || strings.ContainsRune(saved, 0) {
				t.Fatalf("invalid failure reason: bytes=%d valid=%t NUL=%t", len(saved), utf8.ValidString(saved), strings.ContainsRune(saved, 0))
			}
			found := false
			for _, report := range threadReports(t, w) {
				if report.Kind == "message.withdrawn" {
					found = true
					if report.Reason != saved {
						t.Fatal("saved and reported reasons differ")
					}
				}
			}
			if !found {
				t.Fatal("missing failure report")
			}
			threadMessage(t, w, "next", "queue")
			if !reflect.DeepEqual(a.sends, []string{"next"}) {
				t.Fatal("failed reason blocked queue", a.sends)
			}
		})
	}
}

func TestThreadOldLedgerModelsStayEmpty(t *testing.T) {
	a := &threadFake{resume: true}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.AdapterConfig.Model = "old-config-model" }, a)
	threadMessage(t, w, "old-message", "queue")
	a.add(agent.Event{Kind: agent.EventTurnEnded})
	threadMust(t, w.Poll(context.Background()))
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	path, err := ThreadLedgerPath(data, options.ThreadID)
	threadMust(t, err)
	db, err := sql.Open("sqlite", sqliteDSN(path))
	threadMust(t, err)
	for _, table := range []string{"thread_meta", "thread_messages", "thread_turns"} {
		_, err := db.Exec(`ALTER TABLE ` + table + ` DROP COLUMN model`)
		threadMust(t, err)
	}
	_, err = db.Exec(`ALTER TABLE thread_messages DROP COLUMN status_reason`)
	threadMust(t, err)
	threadMust(t, db.Close())
	b := &threadFake{resume: true}
	restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	for _, table := range []string{"thread_meta", "thread_messages", "thread_turns"} {
		if n := threadCount(t, restored, `SELECT COUNT(*) FROM `+table+` WHERE model<>''`); n != 0 {
			t.Fatalf("%s old models were filled: %d", table, n)
		}
	}
	if b.configs[0].Model != "" {
		t.Fatalf("old model was restored from stale adapter config: %+v", b.configs[0])
	}
}

func TestThreadModelMessageRetriesAdapterRecovery(t *testing.T) {
	a := &threadFake{resume: true, switchModel: true}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.Model = "initial" }, a)
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	b := &threadFake{resume: true, switchModel: true, startErr: errors.New("temporarily unavailable")}
	restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	if restored.adapter != nil || threadState(t, restored) != "stopped" {
		t.Fatal("failed restore retained an adapter or lost its stopped state")
	}
	b.startErr = nil
	threadMust(t, restored.EnqueueThreadMessage(context.Background(), "retry-model", "next", "queue", "replacement"))
	if !reflect.DeepEqual(b.sends, []string{"retry-model"}) || !reflect.DeepEqual(b.models, []string{"replacement"}) || threadModel(t, restored) != "replacement" {
		t.Fatalf("model message did not retry adapter recovery: sends=%v models=%v", b.sends, b.models)
	}
}

func TestThreadRecoveredSendIntentRetainsRequestedModel(t *testing.T) {
	a := &threadFake{resume: true, switchModel: true}
	w := newThreadTestWorker(t, func(o *ThreadOptions) { o.Model = "initial" }, a)
	threadMust(t, w.transaction(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO thread_messages(client_message_id,mode,content,status,turn_seq,model) VALUES('crash','queue','body','intent',1,'replacement')`)
		return err
	}))
	data, options := w.dataDir, w.options
	threadMust(t, w.Close())
	b := &threadFake{resume: true, switchModel: true, sent: map[string]bool{"crash": true}}
	b.add(agent.Event{Kind: agent.EventTurnEnded})
	restored, err := OpenThreadWorker(context.Background(), data, options, b.factory)
	threadMust(t, err)
	defer restored.Close()
	if threadModel(t, restored) != "replacement" || len(b.sends) != 0 {
		t.Fatalf("recovered model=%s sends=%v", threadModel(t, restored), b.sends)
	}
	for _, report := range threadReports(t, restored) {
		if (report.Kind == "turn.started" || report.Kind == "turn.ended") && report.Model != "replacement" {
			t.Fatalf("recovered turn model missing: %+v", report)
		}
	}
}

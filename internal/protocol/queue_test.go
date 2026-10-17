package protocol

import (
	"bytes"
	"errors"
	"testing"
)

func TestQueueRejectsOversizeAndFull(t *testing.T) {
	q := NewQueue(MaxQueueMessages, MaxQueueBytes)
	if err := q.Push(nil); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("空消息得到 %v", err)
	}
	if err := q.Push(bytes.Repeat([]byte("a"), MaxMessageBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("超长消息得到 %v", err)
	}
	one := bytes.Repeat([]byte("b"), MaxMessageBytes)
	for i := 0; i < 4; i++ {
		if err := q.Push(one); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.Push(one); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("超过 1 MiB 得到 %v", err)
	}
	small := NewQueue(2, MaxQueueBytes)
	if err := small.Push([]byte("one")); err != nil || small.Push([]byte("two")) != nil {
		t.Fatal("前两条应能入队")
	}
	if err := small.Push([]byte("three")); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("第 3 条得到 %v", err)
	}
	got, ok := small.TryPop()
	if !ok || string(got) != "one" || small.Len() != 1 {
		t.Fatalf("出队结果是 %q len=%d", got, small.Len())
	}
}

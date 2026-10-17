package node

import (
	"testing"
	"time"
)

func TestBackoffStaysInsideJitterWindow(t *testing.T) {
	if BackoffDelay(0, func() float64 { return 0 }) != time.Second {
		t.Fatal("第一次重试不是 1 秒")
	}
	if BackoffDelay(0, func() float64 { return 1 }) != time.Second {
		t.Fatal("1 秒档被抖动缩短或拉长")
	}
	if got := BackoffDelay(1, func() float64 { return 0 }); got != time.Second {
		t.Fatalf("2 秒上限的下限是 %s", got)
	}
	if got := BackoffDelay(1, func() float64 { return 1 }); got != 2*time.Second {
		t.Fatalf("2 秒上限的上限是 %s", got)
	}
	if got := BackoffDelay(20, func() float64 { return 0 }); got != 15*time.Second {
		t.Fatalf("30 秒上限的下限是 %s", got)
	}
	if got := BackoffDelay(20, func() float64 { return 1 }); got != 30*time.Second {
		t.Fatalf("30 秒上限的上限是 %s", got)
	}
}

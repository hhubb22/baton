//go:build windows

package startpermit

import (
	"errors"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsClockMono(t *testing.T) {
	clock := NewClock()
	started := time.Now()
	before, err := clock.Mono()
	if err != nil {
		t.Fatal(err)
	}
	if before <= 0 {
		t.Fatalf("单调时钟 = %s", before)
	}
	previous := before
	for range 100 {
		now, err := clock.Mono()
		if err != nil {
			t.Fatal(err)
		}
		if now < previous {
			t.Fatalf("单调时钟倒退: %s < %s", now, previous)
		}
		previous = now
	}
	time.Sleep(50 * time.Millisecond)
	after, err := clock.Mono()
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := after - before; elapsed < 20*time.Millisecond || elapsed > time.Since(started)+50*time.Millisecond {
		t.Fatalf("50ms 等待后的单调时钟增量 = %s", elapsed)
	}
}

func TestWindowsClockUnavailable(t *testing.T) {
	for _, tt := range []struct {
		name string
		dll  string
		proc string
		want error
	}{
		{"procedure", "api-ms-win-core-realtime-l1-1-1.dll", "BatonMissingQueryInterruptTime", windows.ERROR_PROC_NOT_FOUND},
		{"module", "baton-missing-realtime.dll", "QueryInterruptTime", windows.ERROR_MOD_NOT_FOUND},
	} {
		t.Run(tt.name, func(t *testing.T) {
			proc := windows.NewLazySystemDLL(tt.dll).NewProc(tt.proc)
			for range 2 {
				got, err := readInterruptTime(proc)
				if got != 0 || !errors.Is(err, errNoClock) || !errors.Is(err, tt.want) {
					t.Fatalf("时钟不可用时返回 %s, %v；需要 %v", got, err, tt.want)
				}
			}
		})
	}
}

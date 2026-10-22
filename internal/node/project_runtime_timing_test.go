package node

import (
	"testing"
	"time"
)

func TestProjectRuntimeTiming(t *testing.T) {
	for _, tc := range []struct {
		name    string
		input   ProjectRuntimeTiming
		want    ProjectRuntimeTiming
		invalid bool
	}{
		{name: "defaults", want: ProjectRuntimeTiming{20 * time.Second, 58 * time.Second}},
		{name: "short", input: ProjectRuntimeTiming{time.Second, 2500 * time.Millisecond}, want: ProjectRuntimeTiming{time.Second, 2500 * time.Millisecond}},
		{name: "negative_interval", input: ProjectRuntimeTiming{-time.Second, time.Second}, invalid: true},
		{name: "negative_deadline", input: ProjectRuntimeTiming{time.Second, -time.Second}, invalid: true},
		{name: "equal", input: ProjectRuntimeTiming{time.Second, time.Second}, invalid: true},
		{name: "interval_exceeds_deadline", input: ProjectRuntimeTiming{2 * time.Second, time.Second}, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.input.normalized()
			if (err != nil) != tc.invalid || !tc.invalid && got != tc.want {
				t.Fatalf("normalized() = %+v, %v; want %+v, invalid=%v", got, err, tc.want, tc.invalid)
			}
		})
	}
}

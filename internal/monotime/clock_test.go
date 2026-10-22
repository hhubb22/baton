package monotime

import (
	"testing"
	"time"
)

func TestManualWallJumpsAndSuspend(t *testing.T) {
	c := NewManual(time.Now())
	wall := c.Wall()
	before, err := c.Mono()
	if err != nil {
		t.Fatal(err)
	}
	c.JumpWall(-time.Hour)
	after, err := c.Mono()
	if err != nil || after != before || !c.Wall().Equal(wall.Add(-time.Hour)) {
		t.Fatal(after, err)
	}
	c.Suspend(2 * time.Second)
	after, err = c.Mono()
	if err != nil || after-before != 2*time.Second || !c.Wall().Equal(wall.Add(-time.Hour+2*time.Second)) {
		t.Fatal(after, err)
	}
	c.Advance(time.Second)
	after, err = c.Mono()
	if err != nil || after-before != 3*time.Second {
		t.Fatal(after, err)
	}
}

func TestClockMonotonic(t *testing.T) {
	c := NewClock()
	before, err := c.Mono()
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	after, err := c.Mono()
	if err != nil || after <= before {
		t.Fatal(before, after, err)
	}
	if c.Wall().IsZero() {
		t.Fatal("wall clock unavailable")
	}
}

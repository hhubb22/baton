// Package monotime provides clocks whose monotonic duration includes system sleep.
package monotime

import (
	"sync"
	"time"
)

// Timer 提供墙上时钟和包含休眠的单调时钟。
type Timer interface {
	Wall() time.Time
	Mono() (time.Duration, error)
}

type Clock struct{}

func NewClock() *Clock                      { return &Clock{} }
func (*Clock) Wall() time.Time              { return time.Now() }
func (*Clock) Mono() (time.Duration, error) { return readMono() }

// Manual 是测试用时钟。JumpWall 只移动墙上时间，Suspend 同时推进单调时间和墙上时间。
type Manual struct {
	mu   sync.Mutex
	wall time.Time
	mono time.Duration
}

func NewManual(wall time.Time) *Manual {
	if wall.IsZero() {
		wall = time.Unix(1_700_000_000, 0).UTC()
	}
	return &Manual{wall: wall.UTC()}
}

func (m *Manual) Wall() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.wall
}

func (m *Manual) Mono() (time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mono, nil
}

func (m *Manual) Advance(d time.Duration) {
	m.mu.Lock()
	m.wall = m.wall.Add(d)
	m.mono += d
	m.mu.Unlock()
}

func (m *Manual) JumpWall(d time.Duration) {
	m.mu.Lock()
	m.wall = m.wall.Add(d)
	m.mu.Unlock()
}

func (m *Manual) Suspend(d time.Duration) {
	m.Advance(d)
}

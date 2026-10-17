package startpermit

import (
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Timer 提供墙上时钟和包含休眠的单调时钟。启动判断只用 Mono。
type Timer interface {
	Wall() time.Time
	Mono() (time.Duration, error)
}

// Clock 是进程内时钟。测试可以通过环境变量注入墙上跳变，
// 以及在 Arm 之后的下一次读取里注入暂停唤醒。
type Clock struct {
	armed atomic.Bool
	reads atomic.Int32
}

func NewClock() *Clock {
	return &Clock{}
}

func (c *Clock) Wall() time.Time {
	now := time.Now()
	if c == nil {
		return now
	}
	if off := testDuration("BATON_TEST_WALL_OFFSET"); off != 0 {
		now = now.Add(off)
	}
	return now
}

// Arm 标记许可请求开始，并返回这一刻的单调时间。
// 第一次读取不包含测试注入的暂停，随后的读取才包含。
func (c *Clock) Arm() (time.Duration, error) {
	if c == nil {
		return 0, errNoClock
	}
	c.armed.Store(true)
	return c.Mono()
}

// Restore 在进程重启后恢复已经开始的许可请求。
// 下一次 Mono 会带上测试注入的暂停，从而保留往返期间的时间损失。
func (c *Clock) Restore() {
	if c == nil {
		return
	}
	c.armed.Store(true)
	c.reads.Store(1)
}

func (c *Clock) Mono() (time.Duration, error) {
	if c == nil {
		return 0, errNoClock
	}
	d, err := readMono()
	if err != nil {
		return 0, err
	}
	if c.armed.Load() && c.reads.Add(1) > 1 {
		if extra := testDuration("BATON_TEST_SUSPEND_AFTER_ARM"); extra > 0 {
			d += extra
		}
	}
	return d, nil
}

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

func testDuration(name string) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return 0
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 {
		return 0
	}
	return d
}

package codex

import (
	"context"
	"os"
	"time"
)

func (a *Adapter) Start(ctx context.Context) error {
	if a.config.Restore {
		return a.Attach(ctx)
	}
	if a.config.SessionDir != "" {
		if info, err := os.Lstat(a.config.SessionDir); err == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return ErrHistoryMissing
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := os.MkdirAll(a.config.SessionDir, 0o700); err != nil {
			return err
		}
	}
	return a.CreateSession(ctx)
}

func (a *Adapter) Abort() (bool, bool, error) {
	if stopped, known := a.StopStatus(); stopped {
		return stopped, known, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return a.Interrupt(ctx)
}

func (a *Adapter) StopStatus() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stopped, false
}

func (a *Adapter) DrainLive() (string, bool) { return a.live.Drain() }

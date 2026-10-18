// Package agent defines the process boundary shared by native Agent adapters.
package agent

import (
	"context"
	"errors"
)

var ErrHistoryMissing = errors.New("native Agent history missing or mismatched")

type Output struct {
	WaitingForChildren bool
	Progress           []string
	Final              string
	Exited             bool // The Agent has settled, not merely exited its OS process.
	Uncertain          bool
}

type Config struct {
	Directory   string
	SessionDir  string
	SessionID   string
	ContextFile string
	Model       string
	Binary      string
	Env         []string
	Restore     bool
}

// Adapter never retries task input. Drain is nonblocking; control responses are
// not completion evidence. HistoryContains must inspect persisted native history.
type Adapter interface {
	Start(context.Context) error
	SubmitInput(context.Context, string) (Output, error)
	DeliverResult(context.Context, string, string) (Output, error)
	HistoryContains(deliveryID string, queried bool) (bool, error)
	Drain() []Output
	Abort() (stopped, outcomeKnown bool, err error)
	Close() error
}

// StopObserver retains stop evidence after Abort returns, including on timeout.
// Process exit alone is not settlement; observation must not retry task input.
type StopObserver interface {
	StopStatus() (stopped, outcomeKnown bool)
}

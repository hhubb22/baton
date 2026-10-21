// Package agent defines the process boundary shared by native Agent adapters.
package agent

import (
	"context"
	"encoding/json"
	"errors"
)

var ErrHistoryMissing = errors.New("native Agent history missing or mismatched")

type Output struct {
	WaitingForChildren bool
	Progress           []string
	Final              string
	Exited             bool // The Agent has settled, not merely exited its OS process.
	Uncertain          bool
	Raw                json.RawMessage // Node-local native event; never an ExecutionReport.
}

type Config struct {
	DataDir     string
	Directory   string
	SessionDir  string
	SessionID   string
	ExecutionID string
	StatePath   string
	Home        string
	Model       string
	Binary      string
	Env         []string `json:"-"`
	Restore     bool
}

// Adapter never retries task input. Drain is nonblocking; control responses are
// not completion evidence. HistoryContains must inspect persisted native history.
// ReadHistory returns bounded, node-local pages, never Relay report payloads.
type Adapter interface {
	Start(context.Context) error
	SubmitInput(context.Context, string) (Output, error)
	DeliverResult(context.Context, string, string) (Output, error)
	HistoryContains(deliveryID string, queried bool) (bool, error)
	ReadHistory(context.Context, string) (HistoryPage, error)
	Drain() []Output
	Abort() (stopped, outcomeKnown bool, err error)
	Close() error
}

type HistoryPage struct {
	Data       json.RawMessage
	NextCursor string
}

// StopObserver retains stop evidence after Abort returns, including on timeout.
// Process exit alone is not settlement; observation must not retry task input.
type StopObserver interface {
	StopStatus() (stopped, outcomeKnown bool)
}

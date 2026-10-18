// Package adapters defines the Worker-owned, serialized Agent boundary.
package adapters

import (
	"context"
	"encoding/json"
)

type Capabilities struct {
	Version                                            string
	Start, Input, Interrupt, Resume, History, Delegate bool
}

type Event struct {
	ThreadID, TurnID   string
	Raw                json.RawMessage
	Final              string
	ConfirmedInput     string
	Stopped            bool
	Settled, Uncertain bool
}

type HistoryPage struct {
	Data       json.RawMessage
	NextCursor string
}

// Implementations never retry mutating calls. The Worker persists input intents.
type Adapter interface {
	Probe(context.Context) (Capabilities, error)
	CreateSession(context.Context) error
	Attach(context.Context) error
	StartTask(context.Context, string, string) error
	SendInput(context.Context, string, string) error
	Interrupt(context.Context) (stopped, outcomeKnown bool, err error)
	ReadHistory(context.Context, string) (HistoryPage, error)
	Events() <-chan Event
	Close() error
}

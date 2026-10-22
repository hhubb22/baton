package gateway

import (
	"encoding/json"
	"testing"

	"baton/internal/protocol"
)

func TestThreadReportsAndReceiptsUseControlCapacity(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{protocol.BodyThreadCommandResult, protocol.BodyThreadReport} {
		body, _ := json.Marshal(map[string]any{"type": kind, "future_field": true})
		priority, err := incomingPriority(body)
		if err != nil || priority != protocol.PriorityControl {
			t.Fatalf("%s: %s %v", kind, priority, err)
		}
	}
	for _, kind := range []string{protocol.BodyThreadCommand, protocol.BodyThreadReportResult,
		"agent.request", "execution.control", "execution.children", "execution.child_ack",
		"execution.prepare_result", "execution.start_permit", "execution.start_report", "execution.input", "execution.report"} {
		body, _ := json.Marshal(map[string]string{"type": kind})
		if _, err := incomingPriority(body); err == nil {
			t.Fatalf("node sent coordinator message %s", kind)
		}
	}
}

package codex

import "testing"

func TestDrainIgnoresPreviousTurnAfterSessionReuse(t *testing.T) {
	a := New(Config{})
	defer a.Close()
	a.state.TurnID = "new-turn"
	a.emit(Event{TurnID: "old-turn", Final: `{"summary":"旧结果"}`, Settled: true, Stopped: true})
	a.emit(Event{TurnID: "new-turn", Final: `{"summary":"新结果"}`, Settled: true, Stopped: true})
	output := a.Drain()
	if len(output) != 1 || output[0].Final != `{"summary":"新结果"}` {
		t.Fatal("旧执行结果进入了新执行")
	}
}

func TestUnifiedWaitingOutput(t *testing.T) {
	a := New(Config{})
	defer a.Close()
	a.emit(Event{Settled: true, Final: `{"baton_waiting_for_children":true}`})
	outputs := a.Drain()
	if len(outputs) != 1 || !outputs[0].WaitingForChildren || outputs[0].Exited || outputs[0].Uncertain {
		t.Fatalf("等待子结果: %+v", outputs)
	}
}

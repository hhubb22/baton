package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync/atomic"
)

const (
	// LocalHistoryMarker 是只留在节点账本里的执行过程标记，不能进入中心记录。
	LocalHistoryMarker = "native-history-do-not-sync"
	// ForgedTaskID 是测试执行器放进候选结果、但平台必须丢掉的任务标识。
	ForgedTaskID = "11111111-1111-4111-8111-111111111111"
	// SuccessSummary 是计数执行器明确交回的成功摘要。
	SuccessSummary = "计数执行器已交回结构化结果"
)

// Observer 是仅供测试观察的执行器。准备阶段不能调用 Start、SubmitInput 或 RunStartupHooks。
type Observer struct {
	path   string
	starts atomic.Int64
	hooks  atomic.Int64
	inputs atomic.Int64
}

// Output 是测试执行器对一次任务输入的回应。进程退出和自由文本都不是成功。
type Output struct {
	WaitingForChildren bool
	Progress           []string
	Final              string
	Exited             bool
	Uncertain          bool
}

func NewObserver(path string) *Observer {
	return &Observer{path: strings.TrimSpace(path)}
}

func (o *Observer) Starts() int64 {
	if o == nil {
		return 0
	}
	return o.starts.Load()
}

func (o *Observer) Hooks() int64 {
	if o == nil {
		return 0
	}
	return o.hooks.Load()
}

func (o *Observer) Inputs() int64 {
	if o == nil {
		return 0
	}
	return o.inputs.Load()
}

func (o *Observer) Start(context.Context) error {
	if o == nil {
		return errors.New("没有执行器")
	}
	o.starts.Add(1)
	return o.record("start")
}

// SubmitInput 记录一次任务输入。重复调用会再次计数，调用方必须自己保证只调用一次。
func (o *Observer) SubmitInput(context.Context, string) (Output, error) {
	if o == nil {
		return Output{}, errors.New("没有执行器")
	}
	o.inputs.Add(1)
	if err := o.record("input"); err != nil {
		return Output{}, err
	}
	return scriptedOutput(os.Getenv("BATON_TEST_EXECUTOR_SCRIPT")), nil
}

func (o *Observer) DeliverResult(_ context.Context, deliveryID, payload string) (Output, error) {
	if o == nil || deliveryID == "" || !json.Valid([]byte(payload)) {
		return Output{}, errors.New("结果输入无效")
	}
	o.inputs.Add(1)
	if err := o.record("delivery:" + deliveryID); err != nil {
		return Output{}, err
	}
	return scriptedOutput(os.Getenv("BATON_TEST_DELIVERY_SCRIPT")), nil
}

func scriptedOutput(script string) Output {
	progress := []string{LocalHistoryMarker}
	switch script {
	case "", "running":
		return Output{Progress: progress}
	case "waiting":
		return Output{Progress: progress, WaitingForChildren: true}
	case "candidate_waiting":
		return Output{Progress: progress, Final: successDocument(), WaitingForChildren: true}
	case "text":
		return Output{Progress: progress, Final: "完成", Exited: true}
	case "exit":
		return Output{Progress: progress, Exited: true}
	case "uncertain":
		return Output{Progress: progress, Final: "完成", Exited: true, Uncertain: true}
	case "success":
		return Output{Progress: progress, Final: successDocument(), Exited: true}
	default:
		return Output{Progress: progress, Final: script, Exited: true}
	}
}

func successDocument() string {
	raw, err := json.Marshal(map[string]any{
		"summary": SuccessSummary,
		"evidence": []map[string]string{{
			"storage_ref":   "executor-note",
			"resource_id":   "count-1",
			"access_status": "available",
			"note":          "计数执行器没有外部副作用",
		}},
		"artifacts":              []any{},
		"artifacts_empty_reason": "这次执行没有文件产物",
		"error":                  nil,
		"status":                 "completed",
		"task_id":                ForgedTaskID,
		"target_node_id":         "22222222-2222-4222-8222-222222222222",
		"session_id":             "33333333-3333-4333-8333-333333333333",
	})
	if err != nil {
		return ""
	}
	return string(raw)
}

func (o *Observer) RunStartupHooks(context.Context) error {
	if o == nil {
		return errors.New("没有执行器")
	}
	o.hooks.Add(1)
	return o.record("hook")
}

// Abort 的接口返回不等于停止事实；测试样本分别提供停止和结果可说明证据。
func (o *Observer) Abort() (stopped, outcomeKnown bool, err error) {
	if err := o.record("abort"); err != nil {
		return false, false, err
	}
	switch os.Getenv("BATON_TEST_ABORT_SCRIPT") {
	case "unconfirmed":
		return false, false, nil
	case "unknown":
		return true, false, nil
	default:
		return true, true, nil
	}
}

func (o *Observer) record(line string) error {
	if o.path == "" {
		return nil
	}
	f, err := os.OpenFile(o.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line + "\n")
	return err
}

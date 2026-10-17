package protocol

import "baton/internal/task"

const (
	// BodyExecutionInput 是节点在写入 start_intent 之后领取任务输入。
	BodyExecutionInput = "execution.input"
	// BodyExecutionInputResult 是中心返回的同一次任务输入。
	BodyExecutionInputResult = "execution.input_result"
	// BodyExecutionReport 是节点上报的启动事实或结构化结果。
	BodyExecutionReport = "execution.report"
	// BodyExecutionReportResult 是中心在持久化之后返回的确认。
	BodyExecutionReportResult = "execution.report_result"

	ReportStarted           = task.EventStarted
	ReportResult            = task.EventResult
	ReportNeedsVerification = task.EventNeedsVerification
)

// InputRequest 只标识已经授权的执行，不携带任务说明。
type InputRequest struct {
	Type        string `json:"type"`
	TaskID      string `json:"task_id"`
	ExecutionID string `json:"execution_id"`
	SessionID   string `json:"session_id"`
}

// InputResult 把这一次执行的任务输入交回节点。失败时不带说明正文。
type InputResult struct {
	Type               string   `json:"type"`
	OK                 bool     `json:"ok"`
	Code               string   `json:"code,omitempty"`
	Message            string   `json:"message,omitempty"`
	TaskID             string   `json:"task_id,omitempty"`
	ExecutionID        string   `json:"execution_id,omitempty"`
	Generation         int      `json:"generation,omitempty"`
	Description        string   `json:"description,omitempty"`
	AuthorizationScope *string  `json:"authorization_scope,omitempty"`
	ExpectedOutputs    *string  `json:"expected_outputs,omitempty"`
	WorkingDirectory   *string  `json:"working_directory,omitempty"`
	DeviceNames        []string `json:"device_names,omitempty"`
}

// ExecutionReport 是允许进入中心的执行事实。它不包含会话原文。
type ExecutionReport struct {
	Type                 string           `json:"type"`
	EventID              string           `json:"event_id"`
	TaskID               string           `json:"task_id"`
	ExecutionID          string           `json:"execution_id"`
	SessionID            string           `json:"session_id"`
	Kind                 string           `json:"kind"`
	InputGeneration      int              `json:"input_generation"`
	Status               string           `json:"status"`
	Summary              string           `json:"summary,omitempty"`
	Evidence             []task.ResultRef `json:"evidence,omitempty"`
	Artifacts            []task.ResultRef `json:"artifacts,omitempty"`
	EvidenceEmptyReason  string           `json:"evidence_empty_reason,omitempty"`
	ArtifactsEmptyReason string           `json:"artifacts_empty_reason,omitempty"`
	ErrorCode            string           `json:"error_code,omitempty"`
	ErrorMessage         string           `json:"error_message,omitempty"`
	AgentStopped         bool             `json:"agent_stopped,omitempty"`
}

// ReportAck 只有在中心事务提交成功之后才表示结果已交付。
type ReportAck struct {
	Type    string `json:"type"`
	OK      bool   `json:"ok"`
	Code    string `json:"code,omitempty"`
	EventID string `json:"event_id,omitempty"`
}

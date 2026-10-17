// Package task 描述任务接受时的请求字段、摘要和可以返回给调用方的记录。
package task

import (
	"crypto/sha256"
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"baton/internal/identity"
)

const (
	CodeInvalidRequest = "invalid_request"
	CodeForbidden      = "forbidden"
	CodeInvalidTarget  = "invalid_target"
	CodeUnsupported    = "unsupported"
	CodeConflict       = "conflict"
	CodeSessionBusy    = "session_busy"
	CodeQueueTimeout   = "queue_timeout"
	CodeUnavailable    = "unavailable"
	CodeRevoked        = "revoked"

	StatusQueued            = "queued"
	StatusRunning           = "running"
	StatusNeedsVerification = "needs_verification"
	StatusFailed            = "failed"
	StatusCompleted         = "completed"
	StatusCancelled         = "cancelled"
	EventAccepted           = "accepted"
	EventPrepared           = "prepared"
	EventFailed             = "failed"
	EventStartAuthorized    = "start_authorized"
	EventNeedsVerification  = "needs_verification"
	EventCancelled          = "cancelled"
	ActionPrepare           = "prepare"

	DefaultQueueTimeoutSeconds     = 10 * 60
	DefaultExecutionTimeoutSeconds = 2 * 60 * 60

	// hashSchema 放进摘要，避免以后调整字段顺序时静默把旧请求当成新内容。
	hashSchema = 1

	maxRequestIDRunes  = 200
	maxMultilineRunes  = 32768
	maxDirectoryRunes  = 1024
	maxDeviceNameRunes = 64
	maxDeviceNames     = 32
)

var agentTypePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)

// Input 是调用方提交的原始字段。nil 表示未指定，不代表已经填上默认值。
type Input struct {
	RequestID               string    `json:"request_id"`
	Description             string    `json:"description"`
	SourceSessionID         *string   `json:"source_session_id"`
	ParentTaskID            *string   `json:"parent_task_id"`
	TargetNodeID            *string   `json:"target_node_id"`
	AgentType               *string   `json:"agent_type"`
	TargetSessionID         *string   `json:"target_session_id"`
	WorkingDirectory        *string   `json:"working_directory"`
	DeviceNames             *[]string `json:"device_names"`
	AuthorizationScope      *string   `json:"authorization_scope"`
	ExpectedOutputs         *string   `json:"expected_outputs"`
	QueueTimeoutSeconds     *int      `json:"queue_timeout_seconds"`
	ExecutionTimeoutSeconds *int      `json:"execution_timeout_seconds"`
}

// Prepared 是计算摘要后的请求。能解析的 UUID 已规范成小写。
type Prepared struct {
	Input Input
	Hash  []byte
}

// Record 是已经提交的任务记录。
type Record struct {
	TaskID                  string    `json:"task_id"`
	RequestID               string    `json:"request_id"`
	Description             string    `json:"description"`
	SourceSessionID         *string   `json:"source_session_id"`
	ParentTaskID            *string   `json:"parent_task_id"`
	TargetSessionID         *string   `json:"target_session_id"`
	WorkingDirectory        *string   `json:"working_directory"`
	DeviceNames             []string  `json:"device_names"`
	AuthorizationScope      *string   `json:"authorization_scope"`
	ExpectedOutputs         *string   `json:"expected_outputs"`
	TargetNodeID            string    `json:"target_node_id"`
	AgentType               string    `json:"agent_type"`
	Status                  string    `json:"status"`
	QueueExpiresAt          time.Time `json:"queue_expires_at"`
	ExecutionTimeoutSeconds int       `json:"execution_timeout_seconds"`
	Version                 int       `json:"version"`
	AcceptedAt              time.Time `json:"accepted_at"`
	ErrorCode               *string   `json:"error_code,omitempty"`
	ErrorMessage            *string   `json:"error_message,omitempty"`
}

// Event 是允许保存的一条任务变更，不包含 Session 原文。
type Event struct {
	EventID                 string    `json:"event_id"`
	TaskID                  string    `json:"task_id"`
	Version                 int       `json:"version"`
	Kind                    string    `json:"kind"`
	ActorEmployeeID         string    `json:"actor_employee_id"`
	Status                  string    `json:"status"`
	TargetNodeID            string    `json:"target_node_id"`
	AgentType               string    `json:"agent_type"`
	QueueExpiresAt          time.Time `json:"queue_expires_at"`
	ExecutionTimeoutSeconds int       `json:"execution_timeout_seconds"`
	ReasonCode              *string   `json:"reason_code,omitempty"`
	CreatedAt               time.Time `json:"created_at"`
}

// Rejection 是可以返回给调用方的拒绝，不包含其他员工的数据。
type Rejection struct {
	Code    string
	Message string
	Fields  []string
	TaskID  string
}

func (e *Rejection) Error() string {
	if e == nil || e.Message == "" {
		return "请求被拒绝"
	}
	return e.Message
}

func reject(code, message, field string) *Rejection {
	var fields []string
	if field != "" {
		fields = []string{field}
	}
	return &Rejection{Code: code, Message: message, Fields: fields}
}

type canon struct {
	Schema                  int       `json:"schema"`
	RequestID               string    `json:"request_id"`
	Description             string    `json:"description"`
	SourceSessionID         *string   `json:"source_session_id"`
	ParentTaskID            *string   `json:"parent_task_id"`
	TargetNodeID            *string   `json:"target_node_id"`
	AgentType               *string   `json:"agent_type"`
	TargetSessionID         *string   `json:"target_session_id"`
	WorkingDirectory        *string   `json:"working_directory"`
	DeviceNames             *[]string `json:"device_names"`
	AuthorizationScope      *string   `json:"authorization_scope"`
	ExpectedOutputs         *string   `json:"expected_outputs"`
	QueueTimeoutSeconds     *int      `json:"queue_timeout_seconds"`
	ExecutionTimeoutSeconds *int      `json:"execution_timeout_seconds"`
}

// Prepare 用调用方原始字段计算摘要。未指定的字段保持为空，不填默认节点、Agent 或期限。
// 修改 canon 的字段或顺序后，已保存的 request_hash 将无法与重试对齐。
func Prepare(in Input) (Prepared, error) {
	norm := Input{
		RequestID:               in.RequestID,
		Description:             in.Description,
		SourceSessionID:         foldUUID(in.SourceSessionID),
		ParentTaskID:            foldUUID(in.ParentTaskID),
		TargetNodeID:            foldUUID(in.TargetNodeID),
		AgentType:               copyString(in.AgentType),
		TargetSessionID:         foldUUID(in.TargetSessionID),
		WorkingDirectory:        copyString(in.WorkingDirectory),
		DeviceNames:             copyDevices(in.DeviceNames),
		AuthorizationScope:      copyString(in.AuthorizationScope),
		ExpectedOutputs:         copyString(in.ExpectedOutputs),
		QueueTimeoutSeconds:     copyInt(in.QueueTimeoutSeconds),
		ExecutionTimeoutSeconds: copyInt(in.ExecutionTimeoutSeconds),
	}
	body, err := json.Marshal(canon{
		Schema:                  hashSchema,
		RequestID:               norm.RequestID,
		Description:             norm.Description,
		SourceSessionID:         norm.SourceSessionID,
		ParentTaskID:            norm.ParentTaskID,
		TargetNodeID:            norm.TargetNodeID,
		AgentType:               norm.AgentType,
		TargetSessionID:         norm.TargetSessionID,
		WorkingDirectory:        norm.WorkingDirectory,
		DeviceNames:             norm.DeviceNames,
		AuthorizationScope:      norm.AuthorizationScope,
		ExpectedOutputs:         norm.ExpectedOutputs,
		QueueTimeoutSeconds:     norm.QueueTimeoutSeconds,
		ExecutionTimeoutSeconds: norm.ExecutionTimeoutSeconds,
	})
	if err != nil {
		return Prepared{}, err
	}
	sum := sha256.Sum256(body)
	out := make([]byte, len(sum))
	copy(out, sum[:])
	return Prepared{Input: norm, Hash: out}, nil
}

// ValidateRequestID 检查幂等键本身。空标识无法查找旧请求。
func ValidateRequestID(id string) error {
	if strings.TrimSpace(id) == "" {
		return reject(CodeInvalidRequest, "请求标识不能为空", "request_id")
	}
	if strings.TrimSpace(id) != id || utf8.RuneCountInString(id) > maxRequestIDRunes || hasControl(id) {
		return reject(CodeInvalidRequest, "请求标识无效", "request_id")
	}
	return nil
}

// Validate 检查新请求的字段形状。调用方应先查找旧请求，再调用它。
// 这里不要求目标节点和 Agent 已经指定，默认值由存储层在未命中旧请求后解析。
func Validate(in Input) error {
	if err := ValidateRequestID(in.RequestID); err != nil {
		return err
	}
	if strings.TrimSpace(in.Description) == "" {
		return reject(CodeInvalidRequest, "任务说明不能为空", "description")
	}
	if utf8.RuneCountInString(in.Description) > maxMultilineRunes || hasDisallowedControl(in.Description) {
		return reject(CodeInvalidRequest, "任务说明无效", "description")
	}
	if err := validateUUID(in.SourceSessionID, "来源 Session 标识不正确", "source_session_id"); err != nil {
		return err
	}
	if err := validateUUID(in.ParentTaskID, "来源任务标识不正确", "parent_task_id"); err != nil {
		return err
	}
	if err := validateUUID(in.TargetNodeID, "目标节点标识不正确", "target_node_id"); err != nil {
		return err
	}
	if err := validateUUID(in.TargetSessionID, "目标 Session 标识不正确", "target_session_id"); err != nil {
		return err
	}
	if in.AgentType != nil && !agentTypePattern.MatchString(*in.AgentType) {
		return reject(CodeInvalidRequest, "Agent 类型无效", "agent_type")
	}
	if err := validateOptional(in.WorkingDirectory, "工作目录无效", "working_directory", maxDirectoryRunes, true, false); err != nil {
		return err
	}
	if err := validateOptional(in.AuthorizationScope, "授权范围无效", "authorization_scope", maxMultilineRunes, false, true); err != nil {
		return err
	}
	if err := validateOptional(in.ExpectedOutputs, "期望产物无效", "expected_outputs", maxMultilineRunes, false, true); err != nil {
		return err
	}
	if err := validateDevices(in.DeviceNames, in.AuthorizationScope); err != nil {
		return err
	}
	if err := validateTimeout(in.QueueTimeoutSeconds, "排队等待期限必须是正整数", "queue_timeout_seconds"); err != nil {
		return err
	}
	if err := validateTimeout(in.ExecutionTimeoutSeconds, "执行期限必须是正整数", "execution_timeout_seconds"); err != nil {
		return err
	}
	return nil
}

func validateUUID(p *string, message, field string) error {
	if p == nil {
		return nil
	}
	if _, err := identity.ParseUUID(*p); err != nil {
		return reject(CodeInvalidRequest, message, field)
	}
	return nil
}

func validateOptional(p *string, message, field string, max int, trimStrict, allowLineBreaks bool) error {
	if p == nil {
		return nil
	}
	value := *p
	controls := hasControl(value)
	if allowLineBreaks {
		controls = hasDisallowedControl(value)
	}
	if strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > max || controls {
		return reject(CodeInvalidRequest, message, field)
	}
	if trimStrict && strings.TrimSpace(value) != value {
		return reject(CodeInvalidRequest, message, field)
	}
	return nil
}

func validateDevices(names *[]string, scope *string) error {
	if names == nil {
		return nil
	}
	if len(*names) > maxDeviceNames {
		return reject(CodeInvalidRequest, "设备名称过多", "device_names")
	}
	seen := make(map[string]struct{}, len(*names))
	for _, name := range *names {
		if strings.TrimSpace(name) == "" || strings.TrimSpace(name) != name ||
			utf8.RuneCountInString(name) > maxDeviceNameRunes || hasControl(name) {
			return reject(CodeInvalidRequest, "设备名称无效", "device_names")
		}
		if _, ok := seen[name]; ok {
			return reject(CodeInvalidRequest, "设备名称重复", "device_names")
		}
		seen[name] = struct{}{}
	}
	if len(*names) > 0 && scope == nil {
		return reject(CodeInvalidRequest, "使用设备时必须给出授权范围", "authorization_scope")
	}
	return nil
}

func validateTimeout(p *int, message, field string) error {
	if p == nil {
		return nil
	}
	if *p < 1 || *p > math.MaxInt32 {
		return reject(CodeInvalidRequest, message, field)
	}
	return nil
}

func hasControl(value string) bool {
	for _, r := range value {
		if r == 0x7f || unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// hasDisallowedControl 允许换行、回车和制表符，其余 Unicode 控制字符仍然拒绝。
func hasDisallowedControl(value string) bool {
	for _, r := range value {
		switch r {
		case '\n', '\r', '\t':
			continue
		}
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func foldUUID(p *string) *string {
	if p == nil {
		return nil
	}
	id, err := identity.ParseUUID(*p)
	if err != nil {
		s := *p
		return &s
	}
	return &id
}

func copyString(p *string) *string {
	if p == nil {
		return nil
	}
	s := *p
	return &s
}

func copyInt(p *int) *int {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func copyDevices(p *[]string) *[]string {
	if p == nil {
		return nil
	}
	cp := make([]string, len(*p))
	copy(cp, *p)
	return &cp
}

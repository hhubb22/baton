package task

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"baton/internal/identity"
)

const (
	maxSummaryRunes = 4000
	maxReasonRunes  = 400
	maxRefRunes     = 200
	maxStorageRunes = 1024
	maxResultRefs   = 32
)

// ResultRef 是可以放进中心记录的证据或产物引用，不是会话原文。
type ResultRef struct {
	NodeID       string `json:"node_id,omitempty"`
	StorageRef   string `json:"storage_ref,omitempty"`
	ResourceID   string `json:"resource_id"`
	AccessStatus string `json:"access_status"`
	Note         string `json:"note,omitempty"`
}

// CommandResult 保存一次命令的合并输出和退出事实；输出保留开头、结尾各 16 KiB。
type CommandResult struct {
	Encoding   string `json:"encoding,omitempty"`
	Output     string `json:"output"`
	TotalBytes int64  `json:"total_bytes"`
	ExitCode   int    `json:"exit_code"`
	Truncated  bool   `json:"truncated"`
}

// CommandOutputBytes 是命令原始输出在结果中保留的固定字节数。
const CommandOutputBytes = 32 * 1024

// Candidate 是执行方交回的候选结果。任务、节点和 Session 关联不从这里读取。
type Candidate struct {
	CommandResult        *CommandResult `json:",omitempty"`
	Summary              string
	Evidence             []ResultRef
	Artifacts            []ResultRef
	EvidenceEmptyReason  string
	ArtifactsEmptyReason string
	ErrorCode            string
	ErrorMessage         string
	Status               string
}

type candidateDocument struct {
	CommandResult        *CommandResult `json:"command_result,omitempty"`
	TaskID               string         `json:"task_id,omitempty"`
	TargetNodeID         string         `json:"target_node_id,omitempty"`
	SessionID            string         `json:"session_id,omitempty"`
	ExecutionID          string         `json:"execution_id,omitempty"`
	Summary              string         `json:"summary"`
	Evidence             []ResultRef    `json:"evidence"`
	Artifacts            []ResultRef    `json:"artifacts"`
	EvidenceEmptyReason  string         `json:"evidence_empty_reason,omitempty"`
	ArtifactsEmptyReason string         `json:"artifacts_empty_reason,omitempty"`
	Error                *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Status string `json:"status"`
}

// ParseCandidate 校验执行方交回的 JSON。身份字段即使出现也会被丢掉。
// 自由文本、空文档和进程退出都不是候选结果。
func ParseCandidate(raw string) (Candidate, error) {
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.DisallowUnknownFields()
	var doc candidateDocument
	if err := dec.Decode(&doc); err != nil {
		return Candidate{}, err
	}
	if dec.More() {
		return Candidate{}, errCandidate
	}
	out := Candidate{
		CommandResult:        doc.CommandResult,
		Summary:              doc.Summary,
		Evidence:             doc.Evidence,
		Artifacts:            doc.Artifacts,
		EvidenceEmptyReason:  strings.TrimSpace(doc.EvidenceEmptyReason),
		ArtifactsEmptyReason: strings.TrimSpace(doc.ArtifactsEmptyReason),
		Status:               doc.Status,
	}
	if doc.Error != nil {
		out.ErrorCode = normalizeResultCode(doc.Error.Code)
		out.ErrorMessage = strings.TrimSpace(doc.Error.Message)
	}
	if err := ValidateCandidate(out); err != nil {
		return Candidate{}, err
	}
	return out, nil
}

// FormatFailure 是平台在执行方没有交回约定结构时生成的失败结果。
// uncertain 为 true 时进入待核实，否则是已确认的结果格式错误。
func FormatFailure(uncertain bool) Candidate {
	status := StatusFailed
	if uncertain {
		status = StatusNeedsVerification
	}
	return Candidate{
		Status:               status,
		Summary:              "执行器没有交回可校验的结构化结果",
		EvidenceEmptyReason:  "没有结构化证据",
		ArtifactsEmptyReason: "没有结构化产物",
		ErrorCode:            CodeResultFormat,
		ErrorMessage:         "结果不是约定的结构",
	}
}

// ValidateCommandResult 校验命令的固定输出范围、编码、总字节数及退出码；nil 表示没有命令输出。
func ValidateCommandResult(r *CommandResult) error {
	if r == nil {
		return nil
	}
	retained := []byte(r.Output)
	if r.Encoding == "base64" {
		var err error
		retained, err = base64.StdEncoding.Strict().DecodeString(r.Output)
		if err != nil || base64.StdEncoding.EncodeToString(retained) != r.Output {
			return errCandidate
		}
	} else if r.Encoding != "" || !utf8.ValidString(r.Output) || hasDisallowedControl(r.Output) {
		return errCandidate
	}
	expected := min(r.TotalBytes, int64(CommandOutputBytes))
	if r.TotalBytes < 0 || r.ExitCode < -1 || int64(len(retained)) != expected || r.Truncated != (r.TotalBytes > CommandOutputBytes) {
		return errCandidate
	}
	return nil
}

// ValidateCandidate 检查可以写入中心的结果字段，命令输出受固定字节数限制。
func ValidateCandidate(in Candidate) error {
	if err := ValidateCommandResult(in.CommandResult); err != nil {
		return err
	}
	if r := in.CommandResult; r != nil && ((in.Status == StatusCompleted && r.ExitCode != 0) || (in.Status == StatusFailed && r.ExitCode == 0)) {
		return errCandidate
	}
	switch in.Status {
	case StatusCompleted, StatusFailed, StatusNeedsVerification:
	default:
		return errCandidate
	}
	if strings.TrimSpace(in.Summary) == "" || utf8.RuneCountInString(in.Summary) > maxSummaryRunes || hasDisallowedControl(in.Summary) {
		return errCandidate
	}
	if in.Status == StatusCompleted {
		if in.ErrorCode != "" || in.ErrorMessage != "" {
			return errCandidate
		}
	} else if !validResultError(in.ErrorCode, in.ErrorMessage) {
		return errCandidate
	}
	if err := validateRefs(in.Evidence, in.EvidenceEmptyReason); err != nil {
		return err
	}
	if err := validateRefs(in.Artifacts, in.ArtifactsEmptyReason); err != nil {
		return err
	}
	return nil
}

func validateRefs(refs []ResultRef, emptyReason string) error {
	if len(refs) == 0 {
		if strings.TrimSpace(emptyReason) == "" || utf8.RuneCountInString(emptyReason) > maxReasonRunes || hasControl(emptyReason) {
			return errCandidate
		}
		return nil
	}
	if len(refs) > maxResultRefs {
		return errCandidate
	}
	if emptyReason != "" {
		return errCandidate
	}
	for _, ref := range refs {
		if strings.TrimSpace(ref.ResourceID) == "" || utf8.RuneCountInString(ref.ResourceID) > maxRefRunes || hasControl(ref.ResourceID) {
			return errCandidate
		}
		switch ref.AccessStatus {
		case AccessAvailable, AccessUnavailable, AccessUnknown:
		default:
			return errCandidate
		}
		if ref.NodeID == "" && strings.TrimSpace(ref.StorageRef) == "" {
			return errCandidate
		}
		if ref.NodeID != "" {
			if _, err := identity.ParseUUID(ref.NodeID); err != nil {
				return errCandidate
			}
		}
		if ref.StorageRef != "" && (utf8.RuneCountInString(ref.StorageRef) > maxStorageRunes || hasControl(ref.StorageRef)) {
			return errCandidate
		}
		if ref.Note != "" && (utf8.RuneCountInString(ref.Note) > maxReasonRunes || hasControl(ref.Note)) {
			return errCandidate
		}
	}
	return nil
}

func validResultError(code, message string) bool {
	switch code {
	case CodeResultFormat, CodeExecutionFailed, CodeArtifactUnavailable:
	default:
		return false
	}
	return strings.TrimSpace(message) != "" && utf8.RuneCountInString(message) <= maxReasonRunes && !hasControl(message)
}

func normalizeResultCode(code string) string {
	switch strings.TrimSpace(code) {
	case CodeResultFormat:
		return CodeResultFormat
	case CodeExecutionFailed:
		return CodeExecutionFailed
	case CodeArtifactUnavailable:
		return CodeArtifactUnavailable
	default:
		if strings.TrimSpace(code) == "" {
			return ""
		}
		return CodeExecutionFailed
	}
}

type candidateError struct{}

func (candidateError) Error() string { return "结果格式错误" }

var errCandidate candidateError

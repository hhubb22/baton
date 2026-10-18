package task

import (
	"strings"
	"unicode/utf8"
)

const (
	EventResolved       = "resolved"
	EventRerunRequested = "rerun_requested"
)

type ResolveInput struct {
	ExpectedVersion     int         `json:"expected_version"`
	Status              string      `json:"status"`
	Summary             string      `json:"summary"`
	Reason              string      `json:"reason"`
	Evidence            []ResultRef `json:"evidence"`
	EvidenceEmptyReason string      `json:"evidence_empty_reason,omitempty"`
}

type Resolution struct {
	ResolveInput
	Previous Record `json:"previous"`
}

type RerunInput struct {
	RequestID          string `json:"request_id"`
	ExpectedVersion    int    `json:"expected_version"`
	Reason             string `json:"reason"`
	ConfirmSideEffects bool   `json:"confirm_side_effects"`
}

type Rerun struct {
	RerunInput
	TaskID         string `json:"task_id"`
	PreviousStatus string `json:"previous_status"`
}

func ValidateResolve(in ResolveInput) error {
	if err := validateManual(in.ExpectedVersion, in.Reason); err != nil {
		return err
	}
	switch in.Status {
	case StatusCompleted, StatusFailed, StatusCancelled:
	default:
		return reject(CodeInvalidRequest, "核实结论必须为完成、失败或取消", "status")
	}
	if strings.TrimSpace(in.Summary) == "" || utf8.RuneCountInString(in.Summary) > maxSummaryRunes || hasDisallowedControl(in.Summary) {
		return reject(CodeInvalidRequest, "核实摘要无效", "summary")
	}
	if err := validateRefs(in.Evidence, in.EvidenceEmptyReason); err != nil {
		return reject(CodeInvalidRequest, "核实证据无效；没有证据时需说明原因", "evidence")
	}
	return nil
}

func ValidateRerun(in RerunInput) error {
	if err := ValidateRequestID(in.RequestID); err != nil {
		return err
	}
	return validateManual(in.ExpectedVersion, in.Reason)
}

func validateManual(version int, reason string) error {
	if version < 1 {
		return reject(CodeInvalidRequest, "必须提供当前任务版本", "expected_version")
	}
	if strings.TrimSpace(reason) == "" || utf8.RuneCountInString(reason) > maxReasonRunes || hasControl(reason) {
		return reject(CodeInvalidRequest, "必须提供不超过 400 字的理由", "reason")
	}
	return nil
}

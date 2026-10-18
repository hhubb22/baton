package task

import (
	"strings"
	"time"
	"unicode/utf8"
)

type AcceptanceInput struct {
	ExpectedVersion int    `json:"expected_version"`
	Decision        string `json:"decision"`
	Comment         string `json:"comment"`
}

type Acceptance struct {
	ID          string    `json:"id"`
	TaskID      string    `json:"task_id"`
	TaskVersion int       `json:"task_version"`
	EmployeeID  string    `json:"employee_id"`
	Decision    string    `json:"decision"`
	Comment     string    `json:"comment"`
	CreatedAt   time.Time `json:"created_at"`
}

func ValidateAcceptance(in AcceptanceInput) error {
	if in.ExpectedVersion < 1 {
		return reject(CodeInvalidRequest, "必须提供当前任务版本", "expected_version")
	}
	if in.Decision != "passed" && in.Decision != "rejected" {
		return reject(CodeInvalidRequest, "验收结论必须为 passed 或 rejected", "decision")
	}
	if strings.TrimSpace(in.Comment) == "" || utf8.RuneCountInString(in.Comment) > maxReasonRunes || hasControl(in.Comment) {
		return reject(CodeInvalidRequest, "必须提供不超过 400 字的验收意见", "comment")
	}
	return nil
}

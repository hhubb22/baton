package projectagent

import (
	"encoding/json"
	"errors"

	"baton/internal/protocol"
)

const MaxEventBytes = 160 << 10
const MaxClaimBytes = 128 << 10
const MaxClaimInputs = 20

var ErrLeaseLost = errors.New("运行租约已失效")
var ErrConflict = errors.New("对话序号或事件标识冲突")

type RunCommand struct {
	NodeID  string
	ConnID  string
	Command protocol.ProjectRunCommand
}

type QueuedInput struct {
	ID         int64           `json:"id"`
	SourceType string          `json:"source_type"`
	SourceKey  string          `json:"source_key"`
	Payload    json.RawMessage `json:"payload"`
}

type Bootstrap struct {
	Project        Project `json:"project"`
	PromptVersion  string  `json:"prompt_version"`
	Compaction     *Event  `json:"compaction,omitempty"`
	CompactionSeq  int64   `json:"compaction_seq,omitempty"`
	GoalUTF8Base64 string  `json:"goal_utf8_base64,omitempty"`
	AfterSeq       int64   `json:"after_seq"`
	LastSeq        int64   `json:"last_seq"`
}

type Claim struct {
	Event        *Event `json:"event,omitempty"`
	PayloadBytes int    `json:"payload_bytes"`
	InputCount   int    `json:"input_count"`
}

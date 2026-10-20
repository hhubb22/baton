package projectagent

import "encoding/json"

// PromptSnapshot 保存一次上下文重建使用的固定提示词配置。
type PromptSnapshot struct {
	Version string `json:"version"`
	Title   string `json:"title"`
	Goal    string `json:"goal"`
}

// Compaction 只替换模型视图，原始事件始终保留。
type Compaction struct {
	ThroughSeq            int64           `json:"through_seq"`
	Summary               string          `json:"summary"`
	ClearedToolResultSeqs []int64         `json:"cleared_tool_result_seqs"`
	MemoryIndex           string          `json:"memory_index"`
	Prompt                PromptSnapshot  `json:"prompt"`
	TokensBefore          int64           `json:"tokens_before"`
	TokensAfter           int64           `json:"tokens_after"`
	Provider              string          `json:"provider"`
	Model                 string          `json:"model"`
	Usage                 json.RawMessage `json:"usage,omitempty"`
}

package protocol

const (
	BodyProjectExecSet    = "node.project_exec_set"
	BodyProjectExecResult = "node.project_exec_result"
)

// ProjectExecRequest 只允许本人授权开关，shell 和目录仍由节点本机配置。
type ProjectExecRequest struct {
	Type        string `json:"type"`
	OperationID string `json:"operation_id"`
	Enabled     bool   `json:"enabled"`
}

type ProjectExecResult struct {
	Type        string       `json:"type"`
	OperationID string       `json:"operation_id"`
	OK          bool         `json:"ok"`
	Code        string       `json:"code,omitempty"`
	Exec        *RuntimeExec `json:"exec,omitempty"`
}

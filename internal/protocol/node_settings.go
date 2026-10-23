package protocol

const (
	BodyProjectExecSet          = "node.project_exec_set"
	BodyProjectExecResult       = "node.project_exec_result"
	BodyBrowseRootsSet          = "node.browse_roots_set"
	BodyBrowseRootsResult       = "node.browse_roots_result"
	BodySubscriptionLogin       = "node.subscription_login"
	BodySubscriptionLoginResult = "node.subscription_login_result"
)

// ProjectExecRequest 允许本人设置命令授权开关，shell 由节点本机配置。
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

type BrowseRootsRequest struct {
	Type        string `json:"type"`
	OperationID string `json:"operation_id"`
	Action      string `json:"action"` // add 或 remove。
	Path        string `json:"path"`
}

type BrowseRootsResult struct {
	Type        string        `json:"type"`
	OperationID string        `json:"operation_id"`
	OK          bool          `json:"ok"`
	Code        string        `json:"code,omitempty"`
	Message     string        `json:"message,omitempty"`
	Roots       []RuntimeRoot `json:"roots,omitempty"`
	Repos       []RuntimeRepo `json:"repos,omitempty"`
}

type SubscriptionLoginRequest struct {
	Type        string `json:"type"`
	OperationID string `json:"operation_id"`
	Provider    string `json:"provider"`
}

type SubscriptionLoginResult struct {
	Type             string `json:"type"`
	OperationID      string `json:"operation_id"`
	OK               bool   `json:"ok"`
	Code             string `json:"code,omitempty"`
	Message          string `json:"message,omitempty"`
	Provider         string `json:"provider,omitempty"`
	VerificationURI  string `json:"verification_uri,omitempty"`
	UserCode         string `json:"user_code,omitempty"`
	ExpiresInSeconds int    `json:"expires_in_seconds,omitempty"`
}

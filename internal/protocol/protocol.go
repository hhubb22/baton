// Package protocol 描述节点与 Relay、Relay 与 Coordinator 之间的版本 1 帧。
// Relay 不解释业务 body；来源身份只由认证结果附加。
package protocol

import (
	"encoding/json"
	"errors"
	"time"

	"baton/internal/identity"
)

const (
	Version         = 1
	ToControl       = "control"
	PriorityControl = "control"
	PriorityOutput  = "output"
	SourceNode      = "node"
	SourceControl   = "control"

	NodePath    = "/v1/node"
	ControlPath = "/internal/v1/relay"

	// MaxMessageBytes 是单条传输消息的上限。超限必须拒绝，不能靠分片搬大文件。
	MaxMessageBytes = 256 * 1024
	// MaxQueueMessages 和 MaxQueueBytes 是单连接控制队列的上限。
	MaxQueueMessages = 32
	MaxQueueBytes    = 1 << 20

	KindAuth       = "auth"
	KindAuthResult = "auth_result"
	KindHeartbeat  = "heartbeat"
	KindEnvelope   = "envelope"
	KindError      = "error"
	KindSnapshot   = "snapshot"
	KindSnapshotOK = "snapshot_ok"
	KindRevoke     = "revoke"
	KindRevokeOK   = "revoke_ok"
	KindSessions   = "sessions"
	KindPresence   = "presence"

	CodeInvalidCredential   = "invalid_credential"
	CodeIncarnationConflict = "incarnation_conflict"
	CodeForgedSource        = "forged_source"
	CodeRouteForbidden      = "route_forbidden"
	CodeMessageTooLarge     = "message_too_large"
	CodeQueueFull           = "queue_full"
	CodeControlUnavailable  = "control_unavailable"
	CodeNodeUnavailable     = "node_unavailable"
	CodeVersionRejected     = "version_rejected"
	CodeInvalidMessage      = "invalid_message"
	CodePriorityRejected    = "priority_rejected"
	CodeSyncRejected        = "sync_rejected"
)

var (
	ErrTooLarge       = errors.New("message too large")
	ErrQueueFull      = errors.New("queue full")
	ErrForgedSource   = errors.New("forged source")
	ErrRouteForbidden = errors.New("route forbidden")
	ErrVersion        = errors.New("version rejected")
	ErrInvalidMessage = errors.New("invalid message")
	ErrPriority       = errors.New("priority rejected")
)

// Envelope 是版本 1 的业务信封。body 对 Relay 保持不透明。
type Envelope struct {
	Version       int             `json:"version"`
	MessageID     string          `json:"message_id"`
	Route         Route           `json:"route"`
	Priority      string          `json:"priority"`
	CorrelationID string          `json:"correlation_id,omitempty"`
	Body          json.RawMessage `json:"body,omitempty"`
	Source        *Source         `json:"source,omitempty"`
}

// Route 只表达投递目标。节点上行只能是 control。
type Route struct {
	To string `json:"to"`
}

// Source 是 Relay 根据认证结果附加的来源，不接受节点自报。
type Source struct {
	Kind         string `json:"kind"`
	NodeID       string `json:"node_id,omitempty"`
	EmployeeID   string `json:"employee_id,omitempty"`
	CredentialID string `json:"credential_id,omitempty"`
	Incarnation  string `json:"incarnation,omitempty"`
	ConnID       string `json:"conn_id,omitempty"`
}

// Snapshot 是 Relay 开放节点认证前必须拿到的安全快照。
// 应用快照时拒绝其中的凭据和节点，并断开已经建立的对应连接。
type Snapshot struct {
	ID                 string       `json:"id,omitempty"`
	Version            int          `json:"version"`
	IssuedAt           time.Time    `json:"issued_at"`
	PublicKey          string       `json:"public_key"`
	Issuer             string       `json:"issuer"`
	Audience           string       `json:"audience"`
	HeartbeatMS        int64        `json:"heartbeat_ms"`
	OfflineMS          int64        `json:"offline_ms"`
	RevokedCredentials []Revocation `json:"revoked_credentials"`
	RevokedNodes       []Revocation `json:"revoked_nodes"`
}

// RevokeNotice 是发给已连接 Relay 的吊销补发。Relay 合并进当前快照、断开连接后再回执。
type RevokeNotice struct {
	ID          string       `json:"id"`
	Credentials []Revocation `json:"credentials"`
	Nodes       []Revocation `json:"nodes"`
}

// Revocation 是一条可吊销对象。kind 为 credential 或 node。
type Revocation struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	NodeID    string    `json:"node_id,omitempty"`
	RevokedAt time.Time `json:"revoked_at"`
}

// Presence 是一条连接状态。在线与否由 conn_id 区分，避免旧连接把新连接标离线。
type Presence struct {
	NodeID       string    `json:"node_id"`
	EmployeeID   string    `json:"employee_id"`
	CredentialID string    `json:"credential_id"`
	Incarnation  string    `json:"incarnation"`
	ConnID       string    `json:"conn_id"`
	Online       bool      `json:"online"`
	LastContact  time.Time `json:"last_contact_at"`
}

// Frame 是连接上的一条控制帧。认证帧里的 token 不能写入日志。
type Frame struct {
	Kind          string          `json:"kind"`
	OK            bool            `json:"ok,omitempty"`
	Code          string          `json:"code,omitempty"`
	Message       string          `json:"message,omitempty"`
	Token         string          `json:"token,omitempty"`
	Incarnation   string          `json:"incarnation,omitempty"`
	CorrelationID string          `json:"correlation_id,omitempty"`
	Snapshot      *Snapshot       `json:"snapshot,omitempty"`
	Revoke        *RevokeNotice   `json:"revoke,omitempty"`
	Sessions      []Presence      `json:"sessions,omitempty"`
	Presence      *Presence       `json:"presence,omitempty"`
	Envelope      json.RawMessage `json:"envelope,omitempty"`
	Metrics       *Metrics        `json:"metrics,omitempty"`
}

// Metrics 是 Relay 向控制连接报告的计数。
type Metrics struct {
	OnlineNodes int64 `json:"online_nodes"`
	Connects    int64 `json:"connects"`
	Disconnects int64 `json:"disconnects"`
	Forwards    int64 `json:"forwards"`
	Rejects     int64 `json:"rejects"`
}

// PrepareNodeEnvelope 检查节点发来的信封，拒绝自报来源和非控制目标，并附上认证来源。
// 未知字段会保留，Relay 不解释 body。
func PrepareNodeEnvelope(raw []byte, src Source) ([]byte, error) {
	if len(raw) > MaxMessageBytes {
		return nil, ErrTooLarge
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, ErrInvalidMessage
	}
	if _, ok := fields["source"]; ok {
		return nil, ErrForgedSource
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, ErrInvalidMessage
	}
	if env.Version != Version {
		return nil, ErrVersion
	}
	if _, err := identity.ParseUUID(env.MessageID); err != nil {
		return nil, ErrInvalidMessage
	}
	if env.Priority != "" && env.Priority != PriorityControl && env.Priority != PriorityOutput {
		return nil, ErrPriority
	}
	if env.Route.To != "" && env.Route.To != ToControl {
		return nil, ErrRouteForbidden
	}
	if len(env.CorrelationID) > 128 || hasControl(env.CorrelationID) {
		return nil, ErrInvalidMessage
	}
	src.Kind = SourceNode
	sourceRaw, err := json.Marshal(src)
	if err != nil {
		return nil, ErrInvalidMessage
	}
	route, err := rewriteRoute(fields["route"], ToControl)
	if err != nil {
		return nil, err
	}
	fields["source"] = sourceRaw
	fields["route"] = route
	if _, ok := fields["priority"]; !ok || env.Priority == "" {
		fields["priority"], err = json.Marshal(PriorityControl)
		if err != nil {
			return nil, ErrInvalidMessage
		}
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return nil, ErrInvalidMessage
	}
	if len(out) > MaxMessageBytes {
		return nil, ErrTooLarge
	}
	return out, nil
}

// PrepareControlEnvelope 只允许控制连接选择节点目标，并去掉调用方自带的来源。
func PrepareControlEnvelope(raw []byte) (string, []byte, error) {
	if len(raw) > MaxMessageBytes {
		return "", nil, ErrTooLarge
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", nil, ErrInvalidMessage
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", nil, ErrInvalidMessage
	}
	if env.Version != Version {
		return "", nil, ErrVersion
	}
	if _, err := identity.ParseUUID(env.MessageID); err != nil {
		return "", nil, ErrInvalidMessage
	}
	if env.Priority != "" && env.Priority != PriorityControl {
		return "", nil, ErrPriority
	}
	nodeID, err := identity.ParseUUID(env.Route.To)
	if err != nil {
		return "", nil, ErrRouteForbidden
	}
	delete(fields, "source")
	controlSrc, err := json.Marshal(Source{Kind: SourceControl})
	if err != nil {
		return "", nil, ErrInvalidMessage
	}
	fields["source"] = controlSrc
	route, err := rewriteRoute(fields["route"], nodeID)
	if err != nil {
		return "", nil, err
	}
	fields["route"] = route
	out, err := json.Marshal(fields)
	if err != nil {
		return "", nil, ErrInvalidMessage
	}
	if len(out) > MaxMessageBytes {
		return "", nil, ErrTooLarge
	}
	return nodeID, out, nil
}

func rewriteRoute(raw json.RawMessage, to string) (json.RawMessage, error) {
	fields := map[string]json.RawMessage{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &fields); err != nil {
			return nil, ErrInvalidMessage
		}
	}
	toRaw, err := json.Marshal(to)
	if err != nil {
		return nil, ErrInvalidMessage
	}
	fields["to"] = toRaw
	out, err := json.Marshal(fields)
	if err != nil {
		return nil, ErrInvalidMessage
	}
	return out, nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// CodeOf 把路由错误映射成可返回给对端的 code。
func CodeOf(err error) string {
	switch {
	case errors.Is(err, ErrTooLarge):
		return CodeMessageTooLarge
	case errors.Is(err, ErrQueueFull):
		return CodeQueueFull
	case errors.Is(err, ErrForgedSource):
		return CodeForgedSource
	case errors.Is(err, ErrRouteForbidden):
		return CodeRouteForbidden
	case errors.Is(err, ErrVersion):
		return CodeVersionRejected
	case errors.Is(err, ErrPriority):
		return CodePriorityRejected
	default:
		return CodeInvalidMessage
	}
}

// MessageOf 是给操作者看的短说明，不包含凭据或正文。
func MessageOf(code string) string {
	switch code {
	case CodeInvalidCredential:
		return "需要重新认证"
	case CodeIncarnationConflict:
		return "已有其他进程使用该节点身份"
	case CodeForgedSource:
		return "不能自报来源身份"
	case CodeRouteForbidden:
		return "节点只能把消息发给控制服务"
	case CodeMessageTooLarge:
		return "消息超过 256 KiB 上限"
	case CodeQueueFull:
		return "控制队列已满"
	case CodeControlUnavailable:
		return "控制连接不可用"
	case CodeNodeUnavailable:
		return "目标节点不在线"
	case CodeVersionRejected:
		return "协议版本不受支持"
	case CodePriorityRejected:
		return "当前只接受控制优先级"
	case CodeSyncRejected:
		return "节点状态同步被拒绝"
	default:
		return "消息无法处理"
	}
}

package protocol

import "encoding/json"

const (
	BodyChildDeliveries       = "execution.children"
	BodyChildDeliveriesResult = "execution.children_result"
	BodyChildDeliveryAck      = "execution.child_ack"
)

// ChildDelivery 只携带中心保存的结果，不包含子 Session 历史。
type ChildDelivery struct {
	DeliveryID  string          `json:"delivery_id"`
	TaskID      string          `json:"task_id"`
	ExecutionID string          `json:"execution_id"`
	SessionID   string          `json:"session_id"`
	ChildTaskID string          `json:"child_task_id"`
	Result      json.RawMessage `json:"result"`
}

type ChildReceipt struct {
	DeliveryID string `json:"delivery_id"`
	Status     string `json:"status"`
	Generation int    `json:"input_generation,omitempty"`
}

type ChildDeliveryRequest struct {
	InputRequest
	ChildTaskID string        `json:"child_task_id,omitempty"`
	Receipt     *ChildReceipt `json:"receipt,omitempty"`
}

type ChildDeliveriesResult struct {
	Type       string          `json:"type"`
	OK         bool            `json:"ok"`
	Deliveries []ChildDelivery `json:"deliveries,omitempty"`
}

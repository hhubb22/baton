package task

import "encoding/json"

// ExecutorInputLimit 是 Worker 提交给执行器的任务输入上限，等于单条传输消息的 256 KiB。
// 接受任务时按同一份序列化结果拒绝，避免任务创建后一直停在未提交。
const ExecutorInputLimit = 256 * 1024

type executorInput struct {
	Description        string   `json:"description"`
	AuthorizationScope *string  `json:"authorization_scope,omitempty"`
	ExpectedOutputs    *string  `json:"expected_outputs,omitempty"`
	WorkingDirectory   *string  `json:"working_directory,omitempty"`
	DeviceNames        []string `json:"device_names,omitempty"`
	Generation         int      `json:"generation"`
}

// MarshalExecutorInput 是 Worker 实际交给执行器的 JSON。空的可选字段不出现。
func MarshalExecutorInput(description string, authorization, expected, directory *string, devices []string, generation int) ([]byte, error) {
	var names []string
	if len(devices) > 0 {
		names = append([]string(nil), devices...)
	}
	return json.Marshal(executorInput{
		Description:        description,
		AuthorizationScope: nonEmpty(authorization),
		ExpectedOutputs:    nonEmpty(expected),
		WorkingDirectory:   nonEmpty(directory),
		DeviceNames:        names,
		Generation:         generation,
	})
}

func rejectOversizedExecutorInput(in Input) error {
	var devices []string
	if in.DeviceNames != nil {
		devices = *in.DeviceNames
	}
	raw, err := MarshalExecutorInput(in.Description, in.AuthorizationScope, in.ExpectedOutputs, in.WorkingDirectory, devices, 1)
	if err != nil {
		return reject(CodeInvalidRequest, "任务输入无效", "description")
	}
	if len(raw) <= ExecutorInputLimit {
		return nil
	}
	fields := []string{"description"}
	if nonEmpty(in.AuthorizationScope) != nil {
		fields = append(fields, "authorization_scope")
	}
	if nonEmpty(in.ExpectedOutputs) != nil {
		fields = append(fields, "expected_outputs")
	}
	if nonEmpty(in.WorkingDirectory) != nil {
		fields = append(fields, "working_directory")
	}
	if len(devices) > 0 {
		fields = append(fields, "device_names")
	}
	return &Rejection{
		Code:    CodeInvalidRequest,
		Message: "任务输入超过单条消息上限",
		Fields:  fields,
	}
}

func nonEmpty(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

package protocol

import (
	"bytes"
	"encoding/json"
)

// MarshalJSON 用于 JSON 控制帧，容量按 UTF-8 内容计算，不加入 HTML 页面转义。
func MarshalJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte{'\n'}), nil
}

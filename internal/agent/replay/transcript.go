// Package replay 提供按 LF 分帧的 Agent 转录与确定顺序的回放。
package replay

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const MaxFrame = 8 * 1024 * 1024

type Header struct {
	Type          string `json:"type"`
	Agent         string `json:"agent"`
	Protocol      string `json:"protocol"`
	AgentVersion  string `json:"agent_version"`
	Platform      string `json:"platform"`
	Model         string `json:"model"`
	Scenario      string `json:"scenario"`
	BatonCommit   string `json:"baton_commit"`
	RecordedAt    string `json:"recorded_at"`
	Normalization string `json:"normalization"`
	DroppedFrames int    `json:"dropped_frames"`
	Source        string `json:"source,omitempty"`
	// Bindings 列出回放时必须提供的绑定占位符；其他形如 <name> 的文本按原样比较。
	Bindings []string `json:"bindings,omitempty"`
}

type Entry struct {
	Type    string          `json:"type"`
	Process int             `json:"process"`
	Args    []string        `json:"args,omitempty"`
	Label   string          `json:"label,omitempty"`
	Frame   json.RawMessage `json:"frame,omitempty"`
	Text    string          `json:"text,omitempty"`
	Path    string          `json:"path,omitempty"`
	Append  string          `json:"append,omitempty"`
	Code    int             `json:"code,omitempty"`
	Signal  string          `json:"signal,omitempty"`
}

type Transcript struct {
	Header  Header
	Entries []Entry
}

func Read(r io.Reader) (Transcript, error) {
	var t Transcript
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 4096), MaxFrame)
	if !s.Scan() {
		return t, errors.New("缺少 transcript_start")
	}
	if err := json.Unmarshal(s.Bytes(), &t.Header); err != nil {
		return t, fmt.Errorf("transcript_start: %w", err)
	}
	for line := 2; s.Scan(); line++ {
		var e Entry
		if err := json.Unmarshal(s.Bytes(), &e); err != nil {
			return t, fmt.Errorf("条目 %d: %w", line, err)
		}
		if e.Frame != nil {
			var compact bytes.Buffer
			if err := json.Compact(&compact, e.Frame); err != nil {
				return t, err
			}
			e.Frame = compact.Bytes()
		}
		if len(e.Args) == 0 {
			e.Args = nil
		}
		t.Entries = append(t.Entries, e)
	}
	if err := s.Err(); err != nil {
		return t, err
	}
	return t, t.Validate()
}

func Write(w io.Writer, t Transcript) error {
	if err := t.Validate(); err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(t.Header); err != nil {
		return err
	}
	for _, e := range t.Entries {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

func (t Transcript) Validate() error {
	if t.Header.Type != "transcript_start" {
		return errors.New("首条必须是 transcript_start")
	}
	started, ended, labels := map[int]bool{}, map[int]bool{}, map[string]bool{}
	for i, e := range t.Entries {
		bad := func(reason string) error { return fmt.Errorf("条目 %d (%s): %s", i+2, e.Label, reason) }
		if e.Process < 1 || ended[e.Process] {
			return bad("无效的进程或已结束的进程")
		}
		if e.Label != "" {
			if labels[e.Label] {
				return bad("label 重复")
			}
			labels[e.Label] = true
		}
		switch e.Type {
		case "process_start":
			if started[e.Process] || e.Process != len(started)+1 {
				return bad("process_start 必须从 1 连续编号且不重复")
			}
			started[e.Process] = true
		case "expect_outbound", "emit_inbound":
			v, err := decode(e.Frame)
			if err != nil {
				return bad("frame 必须是 JSON 值")
			}
			if strings.Contains(t.Header.Protocol, "jsonrpc") || strings.Contains(t.Header.Protocol, "json-rpc") {
				if err := validateID(e.Type, v); err != nil {
					return bad(err.Error())
				}
			}
		case "emit_stderr":
		case "native_history":
			if e.Path == "" {
				return bad("native_history 缺少 path")
			}
		case "runtime_exit":
			if e.Code < 0 {
				return bad("退出码必须非负")
			}
			ended[e.Process] = true
		default:
			return bad("未知条目类型")
		}
		if !started[e.Process] {
			return bad("缺少 process_start")
		}
	}
	if len(started) == 0 {
		return errors.New("缺少 process_start")
	}
	return nil
}

func decode(raw []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, errors.New("一帧只能包含一个 JSON 值")
	}
	return v, nil
}

func validateID(direction string, v any) error {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	id, exists := m["id"]
	if !exists {
		return nil
	}
	_, request := m["method"]
	capture := (direction == "expect_outbound") == request
	s, _ := id.(string)
	if capture {
		if !wholeCapture(s) {
			return errors.New("适配器请求的 JSON-RPC id 必须使用完整捕获占位符")
		}
	} else if strings.Contains(s, "<") {
		return errors.New("Agent 请求的 JSON-RPC id 必须保留固定值")
	}
	return nil
}

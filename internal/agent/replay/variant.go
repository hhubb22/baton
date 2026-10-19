package replay

import (
	"bytes"
	"encoding/json"
	"fmt"
)

func (t Transcript) copy() Transcript {
	t.Entries = append([]Entry(nil), t.Entries...)
	for i := range t.Entries {
		t.Entries[i].Frame = bytes.Clone(t.Entries[i].Frame)
		t.Entries[i].Args = append([]string(nil), t.Entries[i].Args...)
	}
	return t
}

func (t Transcript) index(label string, inbound bool) (int, error) {
	for i, e := range t.Entries {
		if e.Label == label && label != "" {
			if inbound && e.Type != "emit_inbound" {
				return 0, fmt.Errorf("%s 必须是入站帧", label)
			}
			return i, nil
		}
	}
	return 0, fmt.Errorf("找不到 label %q", label)
}

// CutAfter 保留指定条目，随后强制终止该进程；其他进程的条目保留。
func (t Transcript) CutAfter(label string) (Transcript, error) {
	i, err := t.index(label, false)
	if err != nil {
		return Transcript{}, err
	}
	out := t.copy()
	process := out.Entries[i].Process
	entries := append([]Entry(nil), out.Entries[:i+1]...)
	if entries[i].Type == "runtime_exit" {
		entries = entries[:i]
	}
	entries = append(entries, Entry{Type: "runtime_exit", Process: process, Code: 137, Signal: "SIGKILL"})
	for _, e := range out.Entries[i+1:] {
		if e.Process != process {
			entries = append(entries, e)
		}
	}
	out.Entries = entries
	return out, out.Validate()
}

func (t Transcript) Drop(label string) (Transcript, error) {
	i, err := t.index(label, true)
	if err != nil {
		return Transcript{}, err
	}
	out := t.copy()
	out.Entries = append(out.Entries[:i], out.Entries[i+1:]...)
	return out, out.Validate()
}

// Replace 用于协议允许而真实 Agent 难以按需产生的帧；调用方应写明原因。
func (t Transcript) Replace(label string, frame json.RawMessage) (Transcript, error) {
	i, err := t.index(label, true)
	if err != nil {
		return Transcript{}, err
	}
	out := t.copy()
	out.Entries[i].Frame = bytes.Clone(frame)
	return out, out.Validate()
}

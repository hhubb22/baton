package replay

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"baton/internal/privatefile"
)

// 每个协议明确声明过滤方法，避免未知协议沿用不适合它的隐私规则。
// Codex 握手需要非空 userAgent 和 codexHome；userAgent 固定为版本说明。
// Pi get_state 的会话、模型和运行状态仍供适配器握手使用。
type normalizationPolicy struct {
	dropMethods   map[string]bool
	privateFields map[string]bool
}

var normalizationPolicies = map[string]normalizationPolicy{
	"codex": {
		dropMethods: stringSet(
			"account/gatewayOAuth/read",
			"account/gatewayOAuth/login",
			"account/gatewayOAuth/cancel",
			"account/gatewayOAuth/changed",
			"account/bedrock/discover",
			"account/bedrock/setup",
			"account/bedrock/checkGovCloudRequirements",
			"account/rateLimitResetCredit/consume",
			"account/usage/read",
			"account/workspaceMessages/read",
			"account/sendAddCreditsNudgeEmail",
			"account/chatgptAuthTokens/refresh",
			"account/read",
			"account/login/start",
			"account/login/cancel",
			"account/logout",
			"account/updated",
			"account/login/completed",
			"account/rateLimits/read",
			"account/rateLimits/updated",
			"mcpServer/oauth/login",
			"mcpServer/oauthLogin/completed",
			// 带主机名 serverName 和安装标识；适配器不处理这条通知。
			"remoteControl/status/changed",
		),
		privateFields: stringSet("account", "authMode", "authStatus", "requiresOpenaiAuth", "accessToken", "refreshToken", "apiKey", "machineId", "deviceId", "hostname", "username", "serverName", "installationId"),
	},
	"pi": {
		dropMethods:   stringSet("get_available_models", "get_commands"),
		privateFields: stringSet("account", "auth", "authStatus", "apiKey", "accessToken", "refreshToken", "machineId", "hostname", "username"),
	},
	"kiro": {
		dropMethods:   stringSet("authenticate", "_kiro/auth/getAccessToken", "_kiro/mcp/status", "_kiro/steering/items_changed", "_kiro/progressive_context/items_changed", "_kiro/powers/items_changed", "_kiro/tools/didChange", "_kiro/sessions/changed", "_kiro/knowledge/items_changed"),
		privateFields: stringSet("authMethods", "accessToken", "refreshToken", "apiKey", "account", "authStatus", "machineId", "hostname", "username"),
	},
}

func stringSet(values ...string) map[string]bool {
	m := map[string]bool{}
	for _, s := range values {
		m[s] = true
	}
	return m
}

type rawFrame struct {
	value    any
	method   string
	request  bool
	response bool
	id       string
}

func parseRawFrame(e RawEntry, agent string) rawFrame {
	if e.Type != "stdin" && e.Type != "stdout" {
		return rawFrame{}
	}
	data := bytes.TrimSuffix(e.Data, []byte{'\n'})
	v, err := decode(data)
	if err != nil {
		return rawFrame{value: map[string]any{"text": string(data)}}
	}
	f := rawFrame{value: v}
	m, ok := v.(map[string]any)
	if !ok {
		return f
	}
	if agent == "pi" {
		f.method, _ = m["type"].(string)
		if f.method == "response" {
			f.method, _ = m["command"].(string)
			f.response = true
		} else {
			f.request = e.Type == "stdin"
		}
	} else {
		f.method, _ = m["method"].(string)
		f.request = f.method != "" && m["id"] != nil
		f.response = f.method == "" && m["id"] != nil
	}
	if id, ok := m["id"]; ok {
		b, _ := json.Marshal(id)
		f.id = string(b)
	}
	return f
}

func requestKey(process int, id string) string { return strconv.Itoa(process) + ":" + id }
func object(v any) map[string]any              { m, _ := v.(map[string]any); return m }
func child(v any, keys ...string) any {
	for _, k := range keys {
		v = object(v)[k]
	}
	return v
}
func str(v any) string { s, _ := v.(string); return s }

// sessions 先识别完整录制中的原生会话，再决定初始化、版本检查和恢复进程的归属。
// 同一 Codex 进程里的帧优先使用 threadId 或对应请求的会话；没有归属的握手帧
// 属于该进程的首个会话。进程启动和退出条目不计入 dropped_frames。
func sessions(raw RawRecording, frames []rawFrame) ([]string, string, error) {
	agent := raw.Header.Transcript.Agent
	owners := make([]string, len(raw.Entries))
	processOwner := map[int]string{}
	requests := map[string]int{}
	historySessions := map[string]string{}
	first := ""
	remember := func(i int, id string) {
		if id == "" {
			return
		}
		owners[i] = id
		if first == "" {
			first = id
		}
		p := raw.Entries[i].Process
		if processOwner[p] == "" {
			processOwner[p] = id
		}
	}
	if agent == "pi" {
		for _, e := range raw.Entries {
			if e.Type != "native_history" {
				continue
			}
			for _, line := range bytes.Split(e.Data, []byte{'\n'}) {
				var m map[string]any
				if json.Unmarshal(line, &m) == nil && m["type"] == "session" {
					historySessions[e.Path] = str(m["id"])
				}
			}
		}
	}
	for i, e := range raw.Entries {
		f := frames[i]
		if agent == "pi" && e.Type == "native_history" {
			remember(i, historySessions[e.Path])
		}
		if agent == "pi" && e.Type == "process_start" {
			id := argument(e.Args, "--session-id")
			if path := argument(e.Args, "--session"); path != "" {
				id = historySessions[path]
				if id == "" {
					for known := range processOwner {
						candidate := processOwner[known]
						base := filepath.Base(strings.ReplaceAll(path, `\`, "/"))
						if base == candidate+".jsonl" || strings.HasSuffix(base, "_"+candidate+".jsonl") {
							id = candidate
							break
						}
					}
				}
				if id == "" {
					return nil, "", fmt.Errorf("条目 %d: 无法从 Pi 历史头部识别 --session", i+2)
				}
			}
			remember(i, id)
		}
		if agent == "codex" || agent == "kiro" {
			if e.Type == "stdin" && f.request {
				requests[requestKey(e.Process, f.id)] = i
			}
			params := child(f.value, "params")
			if agent == "kiro" {
				if id := str(child(params, "sessionId")); id != "" {
					remember(i, id)
				}
			}
			if id := str(child(params, "thread", "id")); id != "" {
				remember(i, id)
			}
			if id := str(child(params, "threadId")); id != "" {
				remember(i, id)
			}
			if e.Type == "stdout" && f.response {
				if req, ok := requests[requestKey(e.Process, f.id)]; ok {
					id := str(child(f.value, "result", "thread", "id"))
					if agent == "kiro" {
						id = str(child(f.value, "result", "sessionId"))
					}
					if id != "" {
						remember(i, id)
						remember(req, id)
					} else {
						owners[i] = owners[req]
					}
				}
			}
		}
	}
	if agent == "kiro" {
		var starts []RawEntry
		for _, e := range raw.Entries {
			if e.Type == "process_start" {
				starts = append(starts, e)
			}
		}
		for i, e := range starts {
			if len(e.Args) == 1 && e.Args[0] == "--version" && i+1 < len(starts) && len(starts[i+1].Args) > 0 && starts[i+1].Args[0] == "acp" {
				processOwner[e.Process] = processOwner[starts[i+1].Process]
			}
		}
	}
	for i, e := range raw.Entries {
		if owners[i] == "" {
			owners[i] = processOwner[e.Process]
		}
	}
	// 对没有 thread 字段的应答，继承对应请求的归属（一个进程可创建多个 thread）。
	for i, e := range raw.Entries {
		if (agent == "codex" || agent == "kiro") && e.Type == "stdout" && frames[i].response {
			if req, ok := requests[requestKey(e.Process, frames[i].id)]; ok {
				owners[i] = owners[req]
			}
		}
	}
	return owners, first, nil
}

type normalizer struct {
	agent        string
	policy       normalizationPolicy
	replacements map[string]string
	counters     map[string]int
	requests     map[string]string
	methods      map[string]string
	agentMethods map[string]string
	labels       map[string]int
}

func (n *normalizer) numbered(kind, original string, capture bool) string {
	if original == "" {
		return ""
	}
	if old := n.replacements[original]; old != "" {
		return old
	}
	n.counters[kind]++
	value := fmt.Sprintf("%s-%d", kind, n.counters[kind])
	if capture {
		value = fmt.Sprintf("<$%s_%d>", kind, n.counters[kind])
	}
	n.replacements[original] = value
	return value
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (n *normalizer) replace(s string) string {
	// 嵌套的 JSON 文本（交付输入、结构化结果和历史行）先解码，路径转义保持正确。
	if json.Valid([]byte(s)) {
		if v, err := decode([]byte(s)); err == nil {
			switch v.(type) {
			case map[string]any, []any:
				before, _ := marshalUnescaped(v)
				b, _ := marshalUnescaped(n.replaceValues(v))
				if bytes.Equal(before, b) {
					return s
				}
				return string(b)
			}
		}
	}
	keys := make([]string, 0, len(n.replacements))
	for k := range n.replacements {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if len(keys[i]) == len(keys[j]) {
			return keys[i] < keys[j]
		}
		return len(keys[i]) > len(keys[j])
	})
	pairs := make([]string, 0, len(keys)*2)
	for _, k := range keys {
		pairs = append(pairs, k, n.replacements[k])
	}
	return strings.NewReplacer(pairs...).Replace(s)
}

func (n *normalizer) replaceValues(v any) any {
	switch x := v.(type) {
	case string:
		return n.replace(x)
	case map[string]any:
		for _, k := range sortedKeys(x) {
			x[k] = n.replaceValues(x[k])
		}
	case []any:
		for i, c := range x {
			x[i] = n.replaceValues(c)
		}
	}
	return v
}

// discoverIDs 只认协议标识字段；模型和工具输出中的业务 id 保持原值。
func (n *normalizer) discoverIDs(v any, context string) {
	switch m := v.(type) {
	case map[string]any:
		for _, k := range sortedKeys(m) {
			s := str(m[k])
			kind := ""
			switch k {
			case "threadId":
				kind = "thread"
			case "turnId", "expectedTurnId":
				kind = "turn"
			case "itemId", "toolCallId", "tool_use_id":
				kind = "item"
			case "sessionId":
				if n.agent == "codex" || n.agent == "kiro" {
					kind = "native-session"
				} else {
					n.numbered("session_id", s, true)
				}
			case "session_id", "execution_id", "executionId", "delivery_id":
				kind := k
				if k == "executionId" {
					kind = "execution_id"
				}
				n.numbered(kind, s, true)
			case "clientUserMessageId":
				if pos := strings.LastIndex(s, ":"); pos > 0 {
					n.numbered("execution_id", s[:pos], true)
				} else {
					n.numbered("operation_id", s, true)
				}
			case "messageId", "replayId", "userMessageId", "userMessageTag":
				if n.agent == "kiro" {
					kind = "message"
				}
			case "parentId":
				kind = "entry"
			case "id":
				if context == "history" && m["type"] != "session" {
					kind = "entry"
				}
				switch context {
				case "thread":
					kind = "thread"
				case "turn", "turns":
					kind = "turn"
				case "item", "items":
					kind = "item"
				case "message", "messages":
					kind = "message"
				}
			}
			if kind != "" {
				n.numbered(kind, s, false)
			}
			// text/output 等业务字符串不参与自动标识发现。
			if k != "output" && k != "aggregatedOutput" && k != "text" {
				n.discoverIDs(m[k], k)
			}
		}
	case []any:
		for _, v := range m {
			n.discoverIDs(v, context)
		}
	}
}

func (n *normalizer) delivery(text string) bool {
	v, err := decode([]byte(text))
	if err != nil {
		return false
	}
	id := str(child(v, "delivery_id"))
	if id == "" {
		return false
	}
	n.numbered("delivery_id", id, true)
	return true
}

func (n *normalizer) outbound(v any, method string) {
	m := object(v)
	if n.agent == "codex" {
		p := object(m["params"])
		switch method {
		case "initialize":
			if p != nil {
				m["params"] = "<any>"
			}
		case "thread/start", "thread/resume":
			for _, k := range []string{"developerInstructions", "baseInstructions", "config"} {
				if _, ok := p[k]; ok {
					p[k] = "<any>"
				}
			}
		case "turn/start", "turn/steer":
			if _, ok := p["outputSchema"]; ok {
				p["outputSchema"] = "<any>"
			}
			inputs, _ := p["input"].([]any)
			for _, input := range inputs {
				item := object(input)
				if text, ok := item["text"].(string); ok && !n.delivery(text) {
					item["text"] = "<any>"
				}
			}
		}
	} else if n.agent == "kiro" {
		p := object(m["params"])
		if method == "session/prompt" {
			for _, block := range array(p["prompt"]) {
				item := object(block)
				if text, ok := item["text"].(string); ok && !n.delivery(text) {
					item["text"] = "<any>"
				}
			}
		}
	} else {
		switch method {
		case "prompt", "steer", "follow_up":
			if text, ok := m["message"].(string); ok && !n.delivery(text) {
				m["message"] = "<any>"
			}
		}
	}
}

func (n *normalizer) strip(v any) {
	m := object(v)
	// 仅删协议顶层/状态字段，不深入模型、工具内容或结构化结果。
	for k := range n.policy.privateFields {
		delete(m, k)
	}
	for _, key := range []string{"result", "data", "params"} {
		c := object(m[key])
		for k := range n.policy.privateFields {
			delete(c, k)
		}
	}
}

func (n *normalizer) label(direction, method string) string {
	if method == "" {
		method = "frame"
	}
	label := direction + ":" + method
	n.labels[label]++
	if n.labels[label] > 1 {
		return fmt.Sprintf("%s:%d", label, n.labels[label])
	}
	return label
}

// Normalize 先完成所有规则和残留扫描；出错时不返回可写出的转录。
func Normalize(raw RawRecording) (Transcript, error) {
	agent := raw.Header.Transcript.Agent
	if raw.Header.Hostname == "" || raw.Header.Username == "" {
		return Transcript{}, errors.New("原始录制缺少主机名或用户名，无法执行残留扫描")
	}
	policy, ok := normalizationPolicies[agent]
	if !ok {
		return Transcript{}, fmt.Errorf("尚未实现 %q 的规范化策略", agent)
	}
	n := normalizer{agent: agent, policy: policy, replacements: map[string]string{}, counters: map[string]int{}, requests: map[string]string{}, methods: map[string]string{}, agentMethods: map[string]string{}, labels: map[string]int{}}
	for token, value := range raw.Header.Bindings {
		if !tokenPattern.MatchString(token) || tokenPattern.FindString(token) != token || token == "<any>" || wholeCapture(token) || value == "" {
			return Transcript{}, fmt.Errorf("无效路径绑定 %q", token)
		}
		if old := n.replacements[value]; old != "" && old != token {
			return Transcript{}, errors.New("同一路径不能有多个绑定")
		}
		n.replacements[value] = token
	}
	frames := make([]rawFrame, len(raw.Entries))
	for i, e := range raw.Entries {
		frames[i] = parseRawFrame(e, agent)
	}
	owners, first, err := sessions(raw, frames)
	if err != nil {
		return Transcript{}, err
	}
	t := Transcript{Header: raw.Header.Transcript}
	t.Header.Type = "transcript_start"
	t.Header.Normalization = "v1"
	t.Header.DroppedFrames = 0
	t.Header.Bindings = make([]string, 0, len(raw.Header.Bindings))
	for token := range raw.Header.Bindings {
		t.Header.Bindings = append(t.Header.Bindings, token)
	}
	sort.Strings(t.Header.Bindings)
	// 先登记保留会话的标识，确保历史中早于协议声明的引用也能替换。
	for i, e := range raw.Entries {
		if owners[i] != "" && owners[i] != first {
			continue
		}
		if e.Type == "process_start" && agent == "pi" {
			n.numbered("session_id", argument(e.Args, "--session-id"), true)
		}
		f := frames[i]
		if e.Type == "stdin" {
			n.outbound(f.value, f.method)
		}
		n.discoverIDs(f.value, "")
		if e.Type == "native_history" {
			for _, line := range bytes.Split(e.Data, []byte{'\n'}) {
				if v, err := decode(line); err == nil {
					n.discoverIDs(v, "history")
				}
			}
		}
	}
	processMap := map[int]int{}
	for i, e := range raw.Entries {
		keep := owners[i] == "" || owners[i] == first
		if e.Type == "process_start" {
			// 同一个进程有父、子会话时，保留进程外壳。
			for j, other := range raw.Entries {
				if other.Process == e.Process && owners[j] == first {
					keep = true
					break
				}
			}
			if !keep {
				continue
			}
			processMap[e.Process] = len(processMap) + 1
		}
		if e.Type == "runtime_exit" && processMap[e.Process] != 0 {
			keep = true
		}
		if !keep {
			if e.Type != "process_start" && e.Type != "runtime_exit" {
				t.Header.DroppedFrames++
			}
			continue
		}
		f := frames[i]
		key := requestKey(e.Process, f.id)
		method := f.method
		if f.response && (agent == "codex" || agent == "kiro") {
			if e.Type == "stdout" {
				method = n.methods[key]
			} else {
				method = n.agentMethods[key]
			}
		}
		if e.Type == "stdin" && f.request {
			n.methods[key] = method
		}
		if e.Type == "stdout" && f.request {
			n.agentMethods[key] = method
		}
		drop := policy.dropMethods[method]
		if agent == "kiro" && method == "session/update" && str(child(f.value, "params", "update", "sessionUpdate")) == "available_commands_update" {
			drop = true
		}
		if drop && (e.Type == "stdin" || e.Type == "stdout") {
			t.Header.DroppedFrames++
			continue
		}
		entry := Entry{Process: processMap[e.Process]}
		switch e.Type {
		case "process_start":
			entry.Type = "process_start"
			entry.Args = append([]string(nil), e.Args...)
			for j, arg := range entry.Args {
				if j > 0 && (entry.Args[j-1] == "--append-system-prompt" || entry.Args[j-1] == "--system-prompt") {
					entry.Args[j] = "<any>"
				} else if strings.HasPrefix(arg, "--append-system-prompt=") || strings.HasPrefix(arg, "--system-prompt=") {
					return Transcript{}, errors.New("系统提示参数请使用独立参数值")
				} else {
					entry.Args[j] = n.replace(arg)
				}
			}
		case "stdin", "stdout":
			entry.Type = "emit_inbound"
			direction := "event"
			if e.Type == "stdin" {
				entry.Type = "expect_outbound"
				direction = "notification"
				if f.request {
					direction = "request"
				}
				n.outbound(f.value, method)
			} else if f.response {
				direction = "response"
			}
			m := object(f.value)
			if f.id != "" && ((e.Type == "stdin" && f.request) || (e.Type == "stdout" && f.response)) {
				capture := n.requests[key]
				if e.Type == "stdin" {
					n.counters["request_id"]++
					capture = fmt.Sprintf("<$request_id_%d>", n.counters["request_id"])
					n.requests[key] = capture
				}
				if capture == "" {
					return Transcript{}, fmt.Errorf("条目 %d: 找不到应答对应的请求", i+2)
				}
				m["id"] = capture
			}
			n.normalizeUserMessages(f.value)
			n.strip(f.value)
			if agent == "kiro" {
				stripKiroPrivate(f.value)
			}
			if agent == "codex" && method == "initialize" && e.Type == "stdout" {
				if result := object(m["result"]); result != nil {
					if _, ok := result["userAgent"]; ok {
						result["userAgent"] = "codex/" + t.Header.AgentVersion
					}
				}
				for _, field := range []string{"platformFamily", "platformOs"} {
					delete(object(m["result"]), field)
				}
			}
			fixedID := m["id"]
			value := n.replaceValues(f.value)
			if (agent == "codex" || agent == "kiro") && ((e.Type == "stdout" && f.request) || (e.Type == "stdin" && f.response)) {
				object(value)["id"] = fixedID
			}
			entry.Frame, err = marshalUnescaped(value)
			if err != nil {
				return Transcript{}, err
			}
			entry.Label = n.label(direction, method)
		case "stderr":
			entry.Type = "emit_stderr"
			entry.Text = n.replace(string(bytes.TrimSuffix(e.Data, []byte{'\n'})))
		case "native_history":
			entry.Type = "native_history"
			entry.Path = n.replace(e.Path)
			var lines []string
			for _, line := range strings.Split(string(e.Data), "\n") {
				if v, err := decode([]byte(line)); err == nil {
					n.normalizeUserMessages(v)
					data, err := marshalUnescaped(n.replaceValues(v))
					if err != nil {
						return Transcript{}, err
					}
					lines = append(lines, string(data))
				} else {
					lines = append(lines, n.replace(line))
				}
			}
			entry.Append = strings.Join(lines, "\n")
		case "runtime_exit":
			entry.Type = "runtime_exit"
			entry.Code = e.Code
			entry.Signal = e.Signal
			entry.Label = n.label("process", "done")
		default:
			return Transcript{}, fmt.Errorf("未知原始条目 %q", e.Type)
		}
		t.Entries = append(t.Entries, entry)
	}
	if err := t.Validate(); err != nil {
		return Transcript{}, err
	}
	if err := scanResiduals(t, raw.Header); err != nil {
		return Transcript{}, err
	}
	return t, nil
}

var residualPatterns = []struct {
	name    string
	pattern *regexp.Regexp
}{
	{"密钥", regexp.MustCompile(`sk-[a-zA-Z0-9_-]+|AKIA[A-Z0-9]+|ghp_[a-zA-Z0-9]+|(?i:Bearer)\s+\S+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----`)},
	{"用户目录", regexp.MustCompile(`(?i:/Users/|/home/|[a-z]:[\\/]+Users[\\/]+)`)},
}

func scanResiduals(t Transcript, h RawHeader) error {
	var data bytes.Buffer
	if err := Write(&data, t); err != nil {
		return err
	}
	var locations []string
	var visit func(any, string)
	visit = func(v any, path string) {
		switch x := v.(type) {
		case string:
			for _, p := range residualPatterns {
				if p.pattern.MatchString(x) {
					locations = append(locations, path+": "+p.name)
				}
			}
			for name, s := range map[string]string{"录制主机名": h.Hostname, "录制用户名": h.Username} {
				if s != "" && strings.Contains(strings.ToLower(x), strings.ToLower(s)) {
					locations = append(locations, path+": "+name)
				}
			}
			if json.Valid([]byte(x)) {
				if nested, err := decode([]byte(x)); err == nil {
					switch nested.(type) {
					case map[string]any, []any:
						visit(nested, path+"(JSON)")
					}
				}
			}
		case map[string]any:
			for _, k := range sortedKeys(x) {
				visit(k, path+"[key]")
				visit(x[k], path+"."+k)
			}
		case []any:
			for i, c := range x {
				visit(c, fmt.Sprintf("%s[%d]", path, i))
			}
		}
	}
	d := json.NewDecoder(&data)
	for line := 1; ; line++ {
		var v any
		if err := d.Decode(&v); err != nil {
			if err == io.EOF {
				break
			}
			return err
		}
		visit(v, fmt.Sprintf("行 %d $", line))
	}
	sort.Strings(locations)
	if len(locations) > 0 {
		return fmt.Errorf("拒绝写出：转录残留敏感信息\n%s", strings.Join(locations, "\n"))
	}
	return nil
}

// NormalizeFile 在扫描通过后原子写出；失败时已有输出保持原样。
func NormalizeFile(input, output string) error {
	if input == output {
		return errors.New("输入和输出必须是不同文件")
	}
	f, err := os.Open(input)
	if err != nil {
		return err
	}
	if outputInfo, statErr := os.Stat(output); statErr == nil {
		inputInfo, err := f.Stat()
		if err != nil {
			f.Close()
			return err
		}
		if os.SameFile(inputInfo, outputInfo) {
			f.Close()
			return errors.New("输入和输出必须是不同文件")
		}
	} else if !os.IsNotExist(statErr) {
		f.Close()
		return statErr
	}
	raw, err := ReadRaw(f)
	f.Close()
	if err != nil {
		return err
	}
	transcript, err := Normalize(raw)
	if err != nil {
		return err
	}
	var b bytes.Buffer
	if err := Write(&b, transcript); err != nil {
		return err
	}
	return privatefile.WriteFile(output, b.Bytes())
}

func marshalUnescaped(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'}), nil
}

// 用户历史里的 Baton 输入沿用出站文本规则；模型和工具的字符串内容不遍历。
func (n *normalizer) normalizeUserMessages(v any) {
	switch m := v.(type) {
	case map[string]any:
		if m["role"] == "user" || m["type"] == "userMessage" || m["sessionUpdate"] == "user_message_chunk" {
			if text, ok := m["content"].(string); ok && !n.delivery(text) {
				m["content"] = "<any>"
			}
			if content := object(m["content"]); content != nil {
				if text, ok := content["text"].(string); ok && !n.delivery(text) {
					content["text"] = "<any>"
				}
			}
			if blocks, ok := m["content"].([]any); ok {
				for _, b := range blocks {
					item := object(b)
					if text, ok := item["text"].(string); ok && !n.delivery(text) {
						item["text"] = "<any>"
					}
				}
			}
		}
		for _, k := range sortedKeys(m) {
			if k != "text" && k != "output" && k != "aggregatedOutput" {
				n.normalizeUserMessages(m[k])
			}
		}
	case []any:
		for _, c := range m {
			n.normalizeUserMessages(c)
		}
	}
}

func array(v any) []any { a, _ := v.([]any); return a }

// 只过滤协议元数据中的日志与认证信息，模型和工具输出保留供扫描拒绝。
func stripKiroPrivate(v any) {
	m := object(v)
	if m == nil {
		return
	}
	if meta := object(m["_meta"]); meta != nil {
		if kiro := object(meta["kiro"]); kiro != nil {
			delete(kiro, "logging")
		}
	}
	for _, key := range []string{"result", "params", "agentCapabilities", "update"} {
		stripKiroPrivate(m[key])
	}
}
